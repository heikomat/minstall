

// minstall.js
// this method isn't needed because npm4 doesn't create dead symlinks
// and incompatible versions created through symlinks are cleaned up
// in removeContradictingInstalledDependencies.
// The dead symlinks created with npm5 are '--clean'ed pre-install anyway.
function removeDeadSymlinksInInstalledDependencies() {
  let folderPaths = [];
  let flattenedFullFilePathArray = [];
  let flattenedScopedFolderPaths = [];
  let folderToCheck = [];

  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      folderPaths = localModules.map((localModule) => {
        return path.join(localModule.fullModulePath, 'node_modules');
      });

      folderPaths.push('.');

      return Promise.all(folderPaths.map((folderPath) => {
        return systools.readdir(folderPath);
      }));
    })
    .then((filesArray) => {
      const fullFilePaths = filesArray.map((files, index) => {
        return files.filter((filename) => {
          return !filename.startsWith('@') && !filename.startsWith('.');
        }).map((filename) => {
          return path.join(folderPaths[index], filename);
        });
      });

      const scopedFolderPaths = filesArray.map((files, index) => {
        return files.filter((filename) => {
          return filename.startsWith('@');
        }).map((filename) => {
          return path.join(folderPaths[index], filename);
        });
      });


      // flatten the filePaths
      flattenedFullFilePathArray = [].concat.apply([], fullFilePaths);
      flattenedScopedFolderPaths = [].concat.apply([], scopedFolderPaths);

      return Promise.all(flattenedScopedFolderPaths.map((scopedFolderPath) => {
        return systools.readdir(scopedFolderPath);
      }));
    })
    .then((scopedDependencyFolder) => {
      const fullScopedFolderPaths = scopedDependencyFolder.map((files, index) => {
        return files.filter((filename) => {
          return !filename.startsWith('.');
        }).map((filename) => {
          return path.join(flattenedScopedFolderPaths[index], filename);
        });
      });

      const flattenedScopedDependecyFolderPaths = [].concat.apply([], fullScopedFolderPaths);
      folderToCheck = flattenedFullFilePathArray.concat(flattenedScopedDependecyFolderPaths);

      return Promise.all(folderToCheck.map((filePath) => {
        return systools.isBrokenSymlink(filePath);
      }));
    })
    .then((brokenSymlinkInfoArray) => {
      const brokenSymlinks = folderToCheck.filter((filePath, index) => {
        return brokenSymlinkInfoArray[index];
      });

      console.log('the following symlinks are broken (point to nowhere) and will be deleted now', brokenSymlinks);
      return Promise.all(brokenSymlinks.map((brokenSymlink) => {
        return systools.delete(brokenSymlink);
      }));
    });
}

// systools.js


readdir(folderPath) {
  return new Promise((resolve, reject) => {

    fs.readdir(folderPath, (error, files) => {
      if (error) {
        if (error.code === 'ENOENT') {
          return resolve([]);
        }

        return reject(error);
      }

      return resolve(files);
    });
  });
},

isBrokenSymlink(location) {
  return this.isSymlink(location)
    .then((isSymlink) => {
      if (!isSymlink) {
        return false;
      }

      return new Promise((resolve, reject) => {
        fs.readlink(location, (error, result) => {
          if (error) {
            return reject(error);
          }

          fs.access(result, fs.constants.F_OK, (accessError) => {
            if (accessError) {
              return resolve(true);
            }

            return resolve(false);
          });
        });
      });
    });
},
