'use strict';

const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');
const systools = require('./systools');
const ModuleInfo = require('./ModuleInfo');
const semver = require('semver');

let logger = null;

const moduletools = {

  modulesFolder: 'modules',
  nullTarget: '/dev/null',
  commandConcatSymbol: ';',

  setModulesFolder(modulesFolder) {
    this.modulesFolder = modulesFolder;
  },

  setNullTarget(nullTarget) {
    this.nullTarget = nullTarget;
  },

  setCommandConcatSymbol(commandConcatSymbol) {
    this.commandConcatSymbol = commandConcatSymbol;
  },

  setLogger(_logger) {
    logger = _logger;
  },

  logVerbose() {
    return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
  },

  getAllModulesAndInstalledDependenciesDeep(location, folderName) {
    if (location === null || location === undefined) {
      location = process.cwd();
    }

    if (folderName === null || folderName === undefined) {
      folderName = this.modulesFolder;
    }

    const result = {
      modules: [],
      installedDependencies: [],
    };

    // get the local modules and the installed modules within the current path
    return Promise.all([
      ModuleInfo.loadFromFolder(location, ''),    // get infos about the current module
      this.getModules(location, 'node_modules'),  // get infos about installed modules in the current module
      this.getModules(location, folderName),      // get infos about local submodules of the current module
    ])
      .then((currentLevelModules) => {

        // the mother-module has installed dependencies, but is not a local module itself!
        if (location !== process.cwd()) {
          result.modules.push(currentLevelModules[0]);
        }
        result.installedDependencies = result.installedDependencies.concat(currentLevelModules[1]);

        // recursively get the local modules and installed dependencies of all the other local modules
        return Promise.all(currentLevelModules[2].map((module) => {
          return this.getAllModulesAndInstalledDependenciesDeep(module.fullModulePath, folderName);
        }));
      })
      .then((otherLevelModules) => {
        for (const moduleAndDependencyInfo of otherLevelModules) {

          result.modules = result.modules.concat(moduleAndDependencyInfo.modules)
            .filter((module) => {
              return module != null;
            });

          result.installedDependencies = result.installedDependencies.concat(moduleAndDependencyInfo.installedDependencies)
            .filter((module) => {
              return module != null;
            });
        }

        return result;
      });
  },

  getModules(location, rootFolder) {
    let scopedFolder = [];
    const result = [];

    if (rootFolder === null || rootFolder === undefined) {
      rootFolder = this.modulesFolder;
    }
    const modulesPath = path.join(location, rootFolder);
    return systools.getFolderNames(modulesPath)
      .then((folderNames) => {
        scopedFolder = folderNames.filter((folderName) => {
          return folderName.indexOf('@') === 0;
        });

        return Promise.all(folderNames.map((folderName) => {
          return this.verifyModule(modulesPath, folderName);
        }));
      })
      .then((moduleNames) => {
        const modules = moduleNames.filter((moduleName) => {
          return moduleName != null;
        });

        // we can't open too many files at once :( read them sequentially
        const serialPromise = modules.reduce((previousPromise, moduleName) => {
          return previousPromise.then(() => {
            return ModuleInfo.loadFromFolder(path.join(location, rootFolder), moduleName)
              .then((module) => {
                result.push(module);
              });
          });
        }, Promise.resolve());

        return serialPromise;
      })
      .then((moduleInfos) => {
        if (scopedFolder.length === 0) {
          return [];
        }

        return Promise.all(scopedFolder.map((folderName) => {
          return this.getModules(path.join(location, rootFolder), folderName);
        }));
      })
      .then((scopedModules) => {
        return result.concat([].concat.apply([], scopedModules));
      });
  },

  verifyModule(location, name) {
    return new Promise((resolve, reject) => {
      let mode = fs.F_OK;
      if (fs.constants) {
        mode = fs.constants.F_OK;
      }

      fs.access(path.join(location, name, 'package.json'), mode, (error) => {
        if (error) {
          // folder has no package.json, thus it is not a module
          return resolve(null);
        }

        return resolve(name);
      });
    });
  },

  installPackets(targetFolder, packets) {

    if (packets.length === 0) {
      return Promise.resolve();
    }

    const identifier = packets.map((packet) => {
      return packet.identifier;
    });

    let npmiLoglevel = 'error';
    let nullTarget = ` > ${this.nullTarget}`;
    if (this.logVerbose()) {
      npmiLoglevel = 'info';
      nullTarget = '';
    }

    return systools.runCommand(`cd ${targetFolder}${this.commandConcatSymbol} npm install --no-save --loglevel ${npmiLoglevel} ${identifier.join(' ')}${nullTarget}`)
      .catch((error) => {

        // This error might just be a warning from npm-install
        process.stdout.write(error.message);
      });
  },
};

module.exports = moduletools;
