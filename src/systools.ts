import {exec} from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import {Winston} from 'winston';

let logger: Winston = null;

export class SystemTools {

  public static setLogger(_logger: Winston): void {
    logger = _logger;
  }

  public static logVerbose(): boolean {
    return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
  }

  public static delete(location: string): Promise<void> {
    logger.verbose('delete', location);

    return new Promise((resolve: Function, reject: Function): void => {
      fs.remove(location, (error: NodeJS.ErrnoException) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve();
          }

          // even if the delete-command failed (e.g. when there was nothing to delete),
          // the script should continue, thus there is no reject
          // tslint:disable-next-line:no-console
          console.log(`error deleting '${location}'`, error);
        }

        return resolve();
      });
    });
  }

  public static link(modulePath: string, targetPath: string): Promise<void> {
    logger.verbose('link', modulePath, '->', targetPath);

    return new Promise((resolve: Function, reject: Function): void => {
      // the typings for fs-extra are wrong. They don't allow 'junction', even though 'junction' is the correct value for symlinks on windows
      // tslint:disable-next-line:no-any
      fs.ensureSymlink(modulePath, targetPath, <any> 'junction', (error: Error) => {

        // even if the link-command failed (e.g. when the link already exists),
        // the script should continue, thus there is no reject
        return resolve();
      });
    });
  }

  public static runCommand(command: string, silent: boolean = false): Promise<string> {
    logger.verbose('running command', command);

    return new Promise<string>((resolve: Function, reject: Function): void => {
      exec(command, {maxBuffer: 2097152}, (error: Error, stdout: string, stderr: string) => {
        if (error !== null) {
          logger.error('ERROR RUNNING COMMAND', command, error);

          return reject(error);
        }

        if (stderr) {
          if (SystemTools.logVerbose()) {
            logger.verbose(`stderr:\n${stderr}`);

            return reject(new Error(''));
          }

          // tslint:disable-next-line:max-line-length
          return reject(new Error(`\nA command from within minstall produced a warning or an error:\ncommand: ${command}\nlog-output:\n${stdout}\n\nmessage:\n${stderr}\n`));
        }

        if (stdout.length > 0 && !silent) {
          process.stdout.write(`\n${stdout}`);
        }

        return resolve(stdout);
      });
    });
  }

  public static async getFolderNames(folderPath: string): Promise<Array<string>> {
    const folderNames: Array<string> = await new Promise<Array<string>>((resolve: Function, reject: Function): void => {

      fs.readdir(folderPath, (error: NodeJS.ErrnoException, files: Array<string>) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve([]);
          }

          return reject(error);
        }

        return resolve(Promise.all<string>(files.map((file: string) => {
          return SystemTools.verifyFolderName(folderPath, file);
        })));
      });
    });

    return folderNames.filter((folderName: string) => {
      return folderName !== null;
    });
  }

  public static verifyFolderName(folderPath: string, folderName: string): Promise<string> {
    if (folderName.indexOf('.') === 0) {
      return Promise.resolve(null);
    }

    const folder: string = path.join(folderPath, folderName);

    return new Promise((resolve: Function, reject: Function): void => {
      fs.stat(folder, (error: NodeJS.ErrnoException, stats: fs.Stats) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve(null);
          }

          return reject(error);
        }

        if (!stats.isDirectory()) {
          return resolve(null);
        }

        return resolve(folderName);
      });
    });
  }

  public static isSymlink(location: string): Promise<boolean> {
    return new Promise((resolve: Function, reject: Function): void => {
      fs.lstat(location, (error: NodeJS.ErrnoException, stats: fs.Stats) => {
        if (error) {
          return reject(error);
        }

        return resolve(stats.isSymbolicLink());
      });
    });
  }

  public static getRuntime(start: number): string {
    // tslint:disable-next-line:no-magic-numbers
    let runSeconds: number = Math.round((Date.now() - start) / 1000);

    // tslint:disable-next-line:no-magic-numbers
    const runMinutes: number = Math.floor(runSeconds / 60);

    // tslint:disable-next-line:no-magic-numbers
    runSeconds %= 60;

    if (runMinutes === 0) {
      return `${runSeconds} seconds`;
    }

    // tslint:disable-next-line:no-magic-numbers
    if (runSeconds < 10) {
      return `${runMinutes}:0${runSeconds} minutes`;
    }

    return `${runMinutes}:${runSeconds} minutes`;
  }
}
