'use strict';

const fs = require('fs');
const path = require('path');
const exec = require('child_process').exec;
const Promise = require('bluebird');

const systools = {

  delete(location) {
    return new Promise((resolve, reject) => {
      fs.unlink(location, (error) => {
        if (error) {
          // even if the delete-command failed (e.g. when there was nothing to delete),
          // the script should continue, thus there is no reject
          console.log(`error deleting '${location}'`, error);
        }

        return resolve();
      });
    });
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
          return reject(new Error(stderr));
        }

        return resolve(stdout);
      });
    });
  },

  getFolderNames(folderPath) {
    return new Promise((resolve, reject) => {

      fs.readdir(folderPath, (error, files) => {
        if (error) {
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
};

module.exports = systools;
