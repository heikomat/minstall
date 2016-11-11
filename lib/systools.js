'use strict';

const fs = require('fs-extra');
const path = require('path');
const exec = require('child_process').exec;
const Promise = require('bluebird');

const systools = {

  delete(location) {
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
        clobber: true,
      });
    }));
  },

  link(modulePath, targetPath) {
    return new Promise((resolve, reject) => {
      fs.symlink(modulePath, targetPath, 'junction', (error) => {

        // even if the link-command failed (e.g. when the link already exists),
        // the script should continue, thus there is no reject
        return resolve();
      });
    });
  },

  runCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error !== null) {
          console.log('ERROR RUNNING COMMAND', command, error);
          return reject(error);
        }

        if (stderr) {
          return reject(new Error(`\nA command from within minstall produced a warning or an error:\ncommand: ${command}\nmessage:\n${stderr}\n`));
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
};

module.exports = systools;
