import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { RedisScriptExecutor } from '../../src/infrastructure/redis/inventory';

const execute = promisify(execFile);

/** Real Redis process, no network credential, fixture clock, or in-memory fake. */
export class RedisHarness implements RedisScriptExecutor {
  private process?: ChildProcess;
  private directory = '';
  private port = 0;
  private startupError: Error | undefined;
  private cli = process.env.REDIS_CLI ?? 'redis-cli';
  async start() {
    this.directory = await mkdtemp(join(tmpdir(), 'cc-redis-'));
    this.port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('No TCP test port'));
          return;
        }
        server.close((error) =>
          error ? reject(error) : resolve(address.port),
        );
      });
    });
    this.process = spawn(
      process.env.REDIS_SERVER ?? 'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(this.port),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        this.directory,
        '--loglevel',
        'warning',
      ],
      { stdio: 'ignore' },
    );
    this.process.on('error', (error) => {
      this.startupError = error;
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (this.startupError) break;
      try {
        if ((await this.command('PING')) === 'PONG') return;
      } catch {
        /* bounded readiness retry */
      }
      await delay(25);
    }
    await this.stop();
    throw new Error(
      'Real Redis integration tests require redis-server and redis-cli >=6.2 on PATH (or REDIS_SERVER/REDIS_CLI paths). The integration suite fails when Redis is unavailable.',
      { cause: this.startupError },
    );
  }
  async command(...args: string[]) {
    const { stdout } = await execute(
      this.cli,
      ['-h', '127.0.0.1', '-p', String(this.port), '--raw', ...args],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim();
  }
  async eval<T>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T> {
    const output = await this.command(
      'EVAL',
      script,
      String(keys.length),
      ...keys,
      ...args.map(String),
    );
    return JSON.parse(output) as T;
  }
  async after(deadline: string) {
    const target = Date.parse(deadline);
    for (let attempt = 0; attempt < 1500; attempt++) {
      const [seconds, micros] = (await this.command('TIME'))
        .split('\n')
        .map(Number);
      if (seconds! * 1000 + Math.floor(micros! / 1000) >= target) return;
      await delay(10);
    }
    throw new Error('Redis clock did not reach the reservation deadline');
  }
  async stop() {
    const child = this.process;
    if (child && child.exitCode === null && !this.startupError) {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGTERM');
      await exited;
    }
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
}
