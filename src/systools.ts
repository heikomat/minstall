import * as Promise from 'bluebird';
import {exec} from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';

let logger = null;

export const systools = {

  setLogger(_logger) {
    logger = _logger;
  },

  logVerbose() {
    return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
  },

  delete(location) {
    logger.verbose('delete', location);
    return new Promise((resolve, reject) => {
      fs.remove(location, (error) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve();
          }

          // even if the delete-command failed (e.g. when there was nothing to delete),
          // the script should continue, thus there is no reject
          console.log(`error deleting '${location}'`, error);
        }

        return resolve();
      });
    });
  },

  link(modulePath, targetPath) {
    logger.verbose('link', modulePath, '->', targetPath);
    return new Promise((resolve, reject) => {
      fs.ensureSymlink(modulePath, targetPath, 'junction', (error) => {

        // even if the link-command failed (e.g. when the link already exists),
        // the script should continue, thus there is no reject
        return resolve();
      });
    });
  },

  runCommand(command, silent) {
    if (silent === undefined || silent === null) {
      silent = false;
    }

    logger.verbose('running command', command);
    return new Promise((resolve, reject) => {
      exec(command, {maxBuffer: 2097152}, (error, stdout, stderr) => {
        if (error !== null) {
          logger.error('ERROR RUNNING COMMAND', command, error);
          return reject(error);
        }

        if (stderr) {
          if (this.logVerbose()) {
            logger.verbose(`stderr:\n${stderr}`);
            return reject(new Error(''));
          }

          return reject(new Error(`\nA command from within minstall produced a warning or an error:\ncommand: ${command}\nlog-output:\n${stdout}\n\nmessage:\n${stderr}\n`));
        }

        if (stdout.length > 0 && !silent) {
          process.stdout.write(`\n${stdout}`);
        }
        return resolve(stdout);
      });
    });
  },

  async getFolderNames(folderPath) {
    const folderNames = await new Promise((resolve, reject) => {

      fs.readdir(folderPath, (error, files) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve([]);
          }

          return reject(error);
        }

        return resolve(Promise.all(files.map((file) => {
          return this.verifyFolderName(folderPath, file);
        })));
      });
    });

    return folderNames.filter((folderName) => {
      return folderName !== null;
    });
  },

  verifyFolderName(folderPath, folderName) {
    if (folderName.indexOf('.') === 0) {
      return Promise.resolve(null);
    }

    const folder = path.join(folderPath, folderName);
    return new Promise((resolve, reject) => {
      fs.stat(folder, (error, stats) => {
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

  isSymlink(location) {
    return new Promise((resolve, reject) => {
      fs.lstat(location, (error, stats) => {
        if (error) {
          return reject(error);
        }

        return resolve(stats.isSymbolicLink());
      });
    });
  },

  getRuntime(start) {
    let runSeconds = Math.round((Date.now() - start) / 1000);
    const runMinutes = Math.floor(runSeconds / 60);
    runSeconds %= 60;

    if (runMinutes === 0) {
      return `${runSeconds} seconds`;
    }

    if (runSeconds < 10) {
      runSeconds = `0${runSeconds}`;
    }
    return `${runMinutes}:${runSeconds} minutes`;
  },
};
