// HAVOC 9 web client: the game's sound, played on the audio thread (an AudioWorklet, loaded by client.js audioFeed).
//
// The engine mixes on the page's main thread, the thread every game frame runs on, always about 0.2 s ahead of what is playing. After each
// mixing pass client.js posts the new stretch here with its place in the stream ({ pos, pcm }: the stream's frame number it starts at, and
// stereo interleaved floats). This thread plays the stream at its own pace whatever the main thread is doing: a frame that runs long, a key
// held down, the scoreboard's cursor. Where nothing has come it plays silence, and counts those frames (starved). It keeps no clock of its
// own: the stream's place now is the audio clock (currentFrame) minus a base, the frame the stream began at, which the page also holds and
// reads the same clock to tell the engine where the play position is.
//
// { flush: true } drops everything held (the engine cleared its own ring: a map change, stopsound). { base } begins the stream again at
// that frame of the clock (the page's count was about to grow past what the engine counts in).
class H9Out extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.len = o.frames || 65536; // frames in the ring: a power of two, far more than the engine sends ahead
    this.mask = this.len - 1;
    this.ring = new Float32Array(this.len * 2); // stereo, interleaved
    this.base = 0; // the audio clock's frame the stream's frame 0 is at
    this.end = 0; // one past the newest frame the page has sent
    this.starved = 0; // frames played as silence because the page had not sent them
    this.pushed = 0; // frames taken in
    this.peak = 0; // the loudest sample played since the last report, for the tests
    this.began = false;
    this.since = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!this.began) return; // the page sends nothing before it has heard "started"
      if (m.pcm) this.put(m.pos, m.pcm);
      else if (m.flush) {
        this.ring.fill(0);
        this.end = this.at();
      } else if (m.base !== undefined) {
        this.base = m.base;
        this.ring.fill(0);
        this.end = this.at();
      }
    };
  }

  at() { return currentFrame - this.base; } // the stream's next frame to play

  put(pos, pcm) {
    const n = pcm.length >> 1;
    const play = this.at();
    let skip = 0;
    if (pos + n <= play) return; // all of it is behind the play position already
    if (pos < play) skip = play - pos; // the start of it is
    for (let i = skip; i < n; i++) {
      const at = ((pos + i) & this.mask) * 2;
      this.ring[at] = pcm[i * 2];
      this.ring[at + 1] = pcm[i * 2 + 1];
    }
    if (pos + n > this.end) this.end = pos + n;
    this.pushed += n - skip;
  }

  process(inputs, outputs) {
    if (!this.began) {
      this.began = true;
      this.base = currentFrame;
      this.port.postMessage({ started: currentFrame }); // the audio clock's frame the stream's frame 0 is at
    }
    const play = this.at();
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    const n = left.length;
    const have = this.end - play; // frames ahead of the play position that have come
    for (let i = 0; i < n; i++) {
      if (i < have) {
        const at = ((play + i) & this.mask) * 2;
        left[i] = this.ring[at];
        right[i] = this.ring[at + 1];
        const loud = Math.abs(left[i]);
        if (loud > this.peak) this.peak = loud;
        this.ring[at] = 0; // played: a lap of the ring must never find it again
        this.ring[at + 1] = 0;
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }
    if (have < n) this.starved += n - Math.max(have, 0);
    this.since += n;
    if (this.since >= 22050) {
      this.since = 0;
      this.port.postMessage({ stats: { played: play + n, starved: this.starved, pushed: this.pushed, peak: this.peak } });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor("h9-out", H9Out);
