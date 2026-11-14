// ---- h9kokoro64: ONNX Runtime, bound at run time -----------------------------------------------------------------------
// onnxruntime.dll is loaded with LoadLibraryExW and its C API is taken from OrtGetApiBase, so the helper builds without ONNX Runtime's import
// library and needs only its header (third_party\onnxruntime). One Kokoro model in one session: the inputs are the phoneme ids (int64 [1, n]),
// the style vector (float [1, 256]) and the speed (float [1]); the output is the waveform (float [1, samples]) at 24 kHz.
//
// Nothing here throws and no ONNX Runtime call is made without its status being looked at. An access violation inside ONNX Runtime is caught
// around the two calls that run its code for long (CreateSession, Run) and comes back as an error, so the process lives and says what happened.
// Run() may be cancelled from another thread (Cancel: RunOptionsSetTerminate); the session is made with the worker threads not spinning, so an
// idle helper uses no CPU.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <stdint.h>
#include <stdio.h>

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include "onnxruntime_c_api.h"

namespace h9k
{
class OrtHost
{
public:
	OrtHost() : m_api(nullptr), m_module(nullptr), m_env(nullptr), m_session(nullptr), m_options(nullptr), m_loadMs(0), m_activeRun(nullptr) {}
	~OrtHost() { Close(); }

	// Loads the DLL (a full path) and binds the API. False with the reason in err.
	bool Load(const wchar_t* dllPath, std::string* err)
	{
		if (m_api)
			return true;
		wchar_t full[1024];
		const DWORD n = GetFullPathNameW(dllPath, 1024, full, nullptr);
		if (n == 0 || n >= 1024)
			return Fail(err, "onnxruntime.dll: the path is not usable");
		// the folder of the DLL first (its own dependencies sit beside it), then System32; older Windows without the flag take the altered search path
		m_module = LoadLibraryExW(full, nullptr, 0x00000100 /*LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR*/ | 0x00000800 /*LOAD_LIBRARY_SEARCH_SYSTEM32*/);
		if (!m_module && GetLastError() == ERROR_INVALID_PARAMETER)
			m_module = LoadLibraryExW(full, nullptr, 0x00000008 /*LOAD_WITH_ALTERED_SEARCH_PATH*/);
		if (!m_module)
		{
			char buf[96];
			snprintf(buf, sizeof(buf), "onnxruntime.dll did not load (Windows error %lu)", GetLastError());
			return Fail(err, buf);
		}
		FARPROC proc = GetProcAddress(m_module, "OrtGetApiBase");
		if (!proc)
			return Fail(err, "onnxruntime.dll has no OrtGetApiBase");
		unsigned long seh = 0;
		const OrtApiBase* base = ApiBase(proc, &seh);
		if (seh || !base)
			return Fail(err, "OrtGetApiBase failed");
		m_version = base->GetVersionString ? base->GetVersionString() : "?";
		for (int level = ORT_API_VERSION; level >= 14 && !m_api; level--)
			m_api = base->GetApi((uint32_t)level);
		if (!m_api)
			return Fail(err, "onnxruntime.dll is older than the API this helper uses");
		return true;
	}

	// Creates the session for a model file. threads is the intra-op thread count. False with the reason in err.
	bool Open(const wchar_t* modelPath, int threads, std::string* err)
	{
		if (!m_api)
			return Fail(err, "onnxruntime is not loaded");
		Close();
		const DWORD t0 = GetTickCount();
		if (!Ok(m_api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "h9kokoro", &m_env), "CreateEnv", err))
			return false;
		if (m_api->DisableTelemetryEvents)
			Ok(m_api->DisableTelemetryEvents(m_env), "DisableTelemetryEvents", nullptr);
		if (!Ok(m_api->CreateSessionOptions(&m_options), "CreateSessionOptions", err))
			return false;
		if (threads < 1)
			threads = 1;
		if (!Ok(m_api->SetIntraOpNumThreads(m_options, threads), "SetIntraOpNumThreads", err)
			|| !Ok(m_api->SetInterOpNumThreads(m_options, 1), "SetInterOpNumThreads", err)
			|| !Ok(m_api->SetSessionExecutionMode(m_options, ORT_SEQUENTIAL), "SetSessionExecutionMode", err)
			|| !Ok(m_api->SetSessionGraphOptimizationLevel(m_options, ORT_ENABLE_ALL), "SetSessionGraphOptimizationLevel", err)
			|| !Ok(m_api->SetSessionLogSeverityLevel(m_options, 3), "SetSessionLogSeverityLevel", err)
			// the worker threads wait on a lock when there is no work instead of spinning: an idle helper uses no CPU
			|| !Ok(m_api->AddSessionConfigEntry(m_options, "session.intra_op.allow_spinning", m_spin ? "1" : "0"), "AddSessionConfigEntry", err))
			return false;
		unsigned long seh = 0;
		OrtStatus* st = CreateSessionGuarded(modelPath, &seh);
		if (seh)
		{
			char buf[96];
			snprintf(buf, sizeof(buf), "CreateSession raised exception 0x%08lx", seh);
			return Fail(err, buf);
		}
		if (!Ok(st, "CreateSession", err))
			return false;
		m_threads = threads;
		m_loadMs = (int)(GetTickCount() - t0);
		return true;
	}

	// The worker threads of the next session spin between operators (faster, uses CPU while a line is being made). Off by default.
	void SetSpin(bool on) { m_spin = on; }

	bool IsOpen() const { return m_session != nullptr; }
	int Threads() const { return m_threads; }
	int LoadMs() const { return m_loadMs; }
	const std::string& Version() const { return m_version; }

	// One synthesis: ids (n of them, the first and the last 0), style (256 floats), speed. The samples go to pcm (24 kHz mono floats).
	// False with the reason in err, also when another thread cancelled the run (err is "cancelled").
	bool Run(const int64_t* ids, size_t n, const float* style, float speed, std::vector<float>& pcm, std::string* err)
	{
		pcm.clear();
		if (!m_session)
			return Fail(err, "no session");
		if (n < 3 || n > 512)
			return Fail(err, "bad number of ids");
		OrtMemoryInfo* mem = nullptr;
		if (!Ok(m_api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &mem), "CreateCpuMemoryInfo", err))
			return false;
		const int64_t idShape[2] = { 1, (int64_t)n };
		const int64_t styleShape[2] = { 1, 256 };
		const int64_t speedShape[1] = { 1 };
		float speedValue = speed;
		OrtValue* in[3] = { nullptr, nullptr, nullptr };
		bool good = Ok(m_api->CreateTensorWithDataAsOrtValue(mem, (void*)ids, n * sizeof(int64_t), idShape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &in[0]),
						   "tensor input_ids", err)
			&& Ok(m_api->CreateTensorWithDataAsOrtValue(mem, (void*)style, 256 * sizeof(float), styleShape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &in[1]),
				   "tensor style", err)
			&& Ok(m_api->CreateTensorWithDataAsOrtValue(mem, &speedValue, sizeof(float), speedShape, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &in[2]),
				   "tensor speed", err);
		OrtRunOptions* ro = nullptr;
		OrtValue* out = nullptr;
		bool cancelled = false;
		if (good)
			good = Ok(m_api->CreateRunOptions(&ro), "CreateRunOptions", err);
		if (good)
		{
			{
				std::lock_guard<std::mutex> lock(m_runMtx);
				m_activeRun = ro;
				if (m_cancelNext)
					m_api->RunOptionsSetTerminate(ro);
				m_cancelNext = false;
			}
			static const char* const inNames[3] = { "input_ids", "style", "speed" };
			static const char* const outNames[1] = { "waveform" };
			unsigned long seh = 0;
			OrtStatus* st = RunGuarded(ro, inNames, in, outNames, &out, &seh);
			{
				std::lock_guard<std::mutex> lock(m_runMtx);
				m_activeRun = nullptr;
			}
			if (seh)
			{
				char buf[96];
				snprintf(buf, sizeof(buf), "Run raised exception 0x%08lx", seh);
				good = Fail(err, buf);
			}
			else if (st)
			{
				const char* msg = m_api->GetErrorMessage(st);
				cancelled = msg && strstr(msg, "terminate") != nullptr;
				good = cancelled ? Fail(err, "cancelled") : Ok(st, "Run", err);
				if (cancelled)
					m_api->ReleaseStatus(st);
			}
		}
		if (good)
		{
			float* data = nullptr;
			OrtTensorTypeAndShapeInfo* info = nullptr;
			size_t count = 0;
			good = Ok(m_api->GetTensorMutableData(out, (void**)&data), "GetTensorMutableData", err)
				&& Ok(m_api->GetTensorTypeAndShape(out, &info), "GetTensorTypeAndShape", err)
				&& Ok(m_api->GetTensorShapeElementCount(info, &count), "GetTensorShapeElementCount", err);
			if (info)
				m_api->ReleaseTensorTypeAndShapeInfo(info);
			if (good && data && count > 0 && count < 24000u * 120u)
				pcm.assign(data, data + count);
			else if (good)
				good = Fail(err, "the model returned no usable audio");
		}
		if (out)
			m_api->ReleaseValue(out);
		for (int i = 0; i < 3; i++)
		{
			if (in[i])
				m_api->ReleaseValue(in[i]);
		}
		if (ro)
			m_api->ReleaseRunOptions(ro);
		if (mem)
			m_api->ReleaseMemoryInfo(mem);
		return good;
	}

	// Asks the run that is going (if any) to come back soon; if none is, the next Run is cancelled at its start. Any thread.
	void Cancel()
	{
		std::lock_guard<std::mutex> lock(m_runMtx);
		if (m_activeRun && m_api)
		{
			OrtStatus* st = m_api->RunOptionsSetTerminate(m_activeRun);
			if (st)
				m_api->ReleaseStatus(st);
		}
		else
			m_cancelNext = true;
	}

	void ClearCancel()
	{
		std::lock_guard<std::mutex> lock(m_runMtx);
		m_cancelNext = false;
	}

	void Close()
	{
		if (!m_api)
			return;
		if (m_session)
			m_api->ReleaseSession(m_session);
		if (m_options)
			m_api->ReleaseSessionOptions(m_options);
		if (m_env)
			m_api->ReleaseEnv(m_env);
		m_session = nullptr;
		m_options = nullptr;
		m_env = nullptr;
	}

private:
	static const OrtApiBase* ApiBase(FARPROC proc, unsigned long* seh)
	{
		const OrtApiBase* base = nullptr;
		*seh = 0;
		__try
		{
			base = ((const OrtApiBase*(ORT_API_CALL*)(void))proc)();
		}
		__except (EXCEPTION_EXECUTE_HANDLER)
		{
			*seh = GetExceptionCode();
		}
		return base;
	}

	OrtStatus* CreateSessionGuarded(const wchar_t* path, unsigned long* seh)
	{
		OrtStatus* st = nullptr;
		*seh = 0;
		__try
		{
			st = m_api->CreateSession(m_env, path, m_options, &m_session);
		}
		__except (EXCEPTION_EXECUTE_HANDLER)
		{
			*seh = GetExceptionCode();
		}
		return st;
	}

	OrtStatus* RunGuarded(const OrtRunOptions* ro, const char* const* inNames, OrtValue* const* in, const char* const* outNames, OrtValue** out,
		unsigned long* seh)
	{
		OrtStatus* st = nullptr;
		*seh = 0;
		__try
		{
			st = m_api->Run(m_session, ro, inNames, in, 3, outNames, 1, out);
		}
		__except (EXCEPTION_EXECUTE_HANDLER)
		{
			*seh = GetExceptionCode();
		}
		return st;
	}

	bool Ok(OrtStatus* st, const char* what, std::string* err)
	{
		if (!st)
			return true;
		if (err)
		{
			char buf[400];
			snprintf(buf, sizeof(buf), "%s: %s", what, m_api->GetErrorMessage(st));
			*err = buf;
		}
		m_api->ReleaseStatus(st);
		return false;
	}

	static bool Fail(std::string* err, const char* why)
	{
		if (err)
			*err = why;
		return false;
	}

	const OrtApi* m_api;
	HMODULE m_module;
	OrtEnv* m_env;
	OrtSession* m_session;
	OrtSessionOptions* m_options;
	std::string m_version;
	int m_threads = 0;
	int m_loadMs;
	bool m_spin = false;
	std::mutex m_runMtx;
	OrtRunOptions* m_activeRun;
	bool m_cancelNext = false;
};
} // namespace h9k
