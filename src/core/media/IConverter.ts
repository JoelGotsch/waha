import { promisify } from 'util';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

export interface IMediaConverter {
  voice(content: Buffer): Promise<Buffer>;
  video(content: Buffer): Promise<Buffer>;
}

export class CoreMediaConverter implements IMediaConverter {
  private async convertWithFfmpeg(
    input: Buffer,
    outputFormat: string,
    ffmpegArgs: string[],
  ): Promise<Buffer> {
    const tmpDir = os.tmpdir();
    const inputFile = path.join(tmpDir, `input-${Date.now()}`);
    const outputFile = path.join(tmpDir, `output-${Date.now()}.${outputFormat}`);

    try {
      await fs.writeFile(inputFile, input);

      const args = ['-i', inputFile, ...ffmpegArgs, outputFile];
      const command = `ffmpeg ${args.join(' ')}`;

      await execAsync(command);

      const result = await fs.readFile(outputFile);
      return result;
    } finally {
      await fs.unlink(inputFile).catch(() => {});
      await fs.unlink(outputFile).catch(() => {});
    }
  }

  async video(content: Buffer): Promise<Buffer> {
    return this.convertWithFfmpeg(
      content,
      'mp4',
      [
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-preset', 'medium',
        '-y',
      ],
    );
  }

  async voice(content: Buffer): Promise<Buffer> {
    return this.convertWithFfmpeg(
      content,
      'ogg',
      [
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vn',
        '-y',
      ],
    );
  }
}
