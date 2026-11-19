import chalk from 'chalk';
import { execSync } from 'child_process';

const BASE_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234';
const REFRESH_MS = 2000;

process.on('SIGINT', () => {
    process.stdout.write('\x1B[?25h'); // restore cursor
    process.exit(0);
});

async function checkServer() {
    const start = Date.now();
    try {
        const res = await fetch(`${BASE_URL}/v1/models`);
        const latency = Date.now() - start;
        const data = await res.json();
        return { up: true, latency, models: data.data || [] };
    } catch {
        return { up: false, latency: null, models: [] };
    }
}

function getProcessInfo() {
    try {
        const out = execSync(
            'netstat -ano 2>nul | findstr ":1234 " | findstr "LISTENING"',
            { shell: 'cmd.exe', stdio: ['pipe', 'pipe', 'ignore'] }
        ).toString();
        const match = out.match(/\s+(\d+)\s*$/m);
        if (!match) return null;
        const pid = match[1].trim();

        const taskOut = execSync(
            `tasklist /FI "PID eq ${pid}" /FO CSV /NH 2>nul`,
            { shell: 'cmd.exe', stdio: ['pipe', 'pipe', 'ignore'] }
        ).toString().trim();

        const parts = taskOut.split(',').map(s => s.replace(/"/g, '').trim());
        if (parts.length < 5) return { pid, name: '?', mem: '?' };
        return { pid, name: parts[0], mem: parts[4] };
    } catch {
        return null;
    }
}

function draw(status, proc) {
    process.stdout.write('\x1B[2J\x1B[H\x1B[?25l'); // clear + hide cursor

    console.log(chalk.cyan(' ================================================='));
    console.log(chalk.cyan('   LM Studio  >>  Server Monitor'));
    console.log(chalk.cyan(`   ${BASE_URL}`));
    console.log(chalk.cyan(' ================================================='));
    console.log();

    if (status.up) {
        console.log(chalk.green('  OK') + chalk.white('     Server is running') +
                    chalk.dim(`  (${status.latency}ms)`));
    } else {
        console.log(chalk.red('  !!') + chalk.white('     Server is not responding'));
        console.log(chalk.dim('         Run start-server.cmd to start it'));
    }

    console.log();

    if (proc) {
        console.log(chalk.white(' Process:'));
        console.log(chalk.dim('         PID:    ') + chalk.white(proc.pid));
        console.log(chalk.dim('         Name:   ') + chalk.white(proc.name));
        console.log(chalk.dim('         Memory: ') + chalk.white(proc.mem));
    } else if (status.up) {
        console.log(chalk.dim(' Process info unavailable'));
    }

    console.log();

    if (status.models.length > 0) {
        console.log(chalk.white(` Loaded models (${status.models.length}):`));
        for (const model of status.models) {
            console.log(chalk.dim('         - ') + chalk.white(model.id));
        }
    } else if (status.up) {
        console.log(chalk.yellow('  --') + chalk.white('     No models loaded'));
        console.log(chalk.dim('         Load one in LM Studio to enable queries'));
    }

    console.log();
    console.log(chalk.dim(` Refreshing every ${REFRESH_MS / 1000}s  --  Ctrl+C to exit (server keeps running)`));
    console.log(chalk.dim(` ${new Date().toLocaleTimeString()}`));
}

(async function loop() {
    while (true) {
        const [status, proc] = await Promise.all([checkServer(), Promise.resolve(getProcessInfo())]);
        draw(status, proc);
        await new Promise(r => setTimeout(r, REFRESH_MS));
    }
})();
