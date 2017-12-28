'use strict';

const fs = require('fs-extra');
const path = require('path');
const exec = require('child_process').exec;
const Promise = require('bluebird');

let logger = null;

const systools = {

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

  move(from, to, options) {
    logger.verbose('move', from, '->', to);
    return new Promise((resolve, reject) => {
      fs.move(from, to, options, (error) => {
        if (error) {
          return reject(error);
        }

        return resolve();
      });
    });
  },

  moveMultiple(names, from, to) {
    return Promise.all(names.map((name) => {
      return this.move(path.join(from, name), path.join(to, name), {
        overwrite: true,
      });
    }));
  },

  deleteMultiple(names, from) {
    return Promise.all(names.map((name) => {
      return this.delete(path.join(from, name));
    }));
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

  mkdir(location) {
    logger.verbose('mkdir', location);
    return new Promise((resolve, reject) => {
      fs.mkdirs(location, (error) => {
        if (error) {
          return reject();
        }

        return resolve();
      });
    });
  },

  runCommand(command) {
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

        if (stdout.length > 0) {
          process.stdout.write(`\n${stdout}`);
        }
        return resolve(stdout);
      });
    });
  },

  getFolderNames(folderPath) {
    return new Promise((resolve, reject) => {

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
    })
      .then((folderNames) => {

        return folderNames.filter((folderName) => {
          return folderName != null;
        });
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

  deleteEmptyFolders(location) {
    return this.getFolderNames(location)
      .then((folderNames) => {
        return Promise.all(folderNames.map((folderName) => {
          return this.deleteIfEmptyFolder(path.join(location, folderName));
        }));
      });
  },

  deleteIfEmptyFolder(location) {
    fs.readdir(location, (error, files) => {
      if (error) {
        return Promise.reject(error);
      }

      if (files.length > 0) {
        return Promise.resolve();
      }

      return this.delete(location);
    });
  },


  isChildOf(child, parent) {
    if (child === parent) {
      return false;
    }

    const parentTokens = parent.split(path.sep)
      .filter((parentToken) => {
        return parentToken.length > 0;
      });

    const childTokens = child.split(path.sep)
      .filter((childToken) => {
        return childToken.length > 0;
      });

    return parentTokens.every((parentToken, tokenIndex) => {
      return childTokens[tokenIndex] === parentToken;
    });
  },
};

module.exports = systools;
