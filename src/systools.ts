import {exec} from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as logger from 'winston';

export const SystemTools = {

  logVerbose: function logVerbose(): boolean {
    return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
  },

  delete: function _delete(location: string): Promise<void> {
    logger.verbose('delete', location);

    return new Promise((resolve: Function, reject: Function): void => {
      fs.remove(location, (error: NodeJS.ErrnoException) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve();
          }

          // even if the delete-command failed (e.g. when there was nothing to delete),
          // the script should continue, thus there is no reject
          // eslint-disable-next-line no-console
          console.log(`error deleting '${location}'`, error);
        }

        return resolve();
      });
    });
  },

  link: function link(modulePath: string, targetPath: string): Promise<void> {
    logger.verbose('link', modulePath, '->', targetPath);

    return new Promise((resolve: Function, reject: Function): void => {
      // the typings for fs-extra are wrong. They don't allow 'junction', even though 'junction' is the correct value for symlinks on windows
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fs.ensureSymlink(modulePath, targetPath, <any> 'junction', (error: Error) => {

        // even if the link-command failed (e.g. when the link already exists),
        // the script should continue, thus there is no reject
        return resolve();
      });
    });
  },

  runCommand: function runCommand(command: string, silent = false): Promise<string> {
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

          // eslint-disable-next-line max-len
          return reject(new Error(`\nA command from within minstall produced a warning or an error:\ncommand: ${command}\nlog-output:\n${stdout}\n\nmessage:\n${stderr}\n`));
        }

        if (stdout.length > 0 && !silent) {
          process.stdout.write(`\n${stdout}`);
        }

        return resolve(stdout);
      });
    });
  },

  getFolderNames: async function getFolderNames(folderPath: string): Promise<Array<string>> {
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
  },

  verifyFolderName: function verifyFolderName(folderPath: string, folderName: string): Promise<string> {
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
  },

  isSymlink: function isSymlink(location: string): Promise<boolean> {
    return new Promise((resolve: Function, reject: Function): void => {
      fs.lstat(location, (error: NodeJS.ErrnoException, stats: fs.Stats) => {
        if (error) {
          return reject(error);
        }

        return resolve(stats.isSymbolicLink());
      });
    });
  },

  getRuntime: function getRuntime(start: number): string {
    let runSeconds: number = Math.round((Date.now() - start) / 1000);

    const runMinutes: number = Math.floor(runSeconds / 60);

    runSeconds %= 60;

    if (runMinutes === 0) {
      return `${runSeconds} seconds`;
    }

    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    if (runSeconds < 10) {
      return `${runMinutes}:0${runSeconds} minutes`;
    }

    return `${runMinutes}:${runSeconds} minutes`;
  },
};
