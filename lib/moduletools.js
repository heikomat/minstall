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
      this.getModules(location, folderName),
      this.getModules(location, 'node_modules'),
    ])
      .then((currentLevelModules) => {

        result.modules = result.modules.concat(currentLevelModules[0]);
        result.installedDependencies = result.installedDependencies.concat(currentLevelModules[1]);

        // recursively get the local modules and installed dependencies of all the other local modules
        return Promise.all(currentLevelModules[0].map((module) => {
          return this.getAllModulesAndInstalledDependenciesDeep(module.location, module.realFolderName);
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
    let result = [];

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

        return Promise.all(modules.map((moduleName) => {
          return ModuleInfo.loadFromFolder(path.join(location, rootFolder), moduleName);
        }));
      })
      .then((moduleInfos) => {
        result = moduleInfos;
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

  getModuleLogText(moduleInfos) {
    const moduleNames = moduleInfos.map((moduleInfo) => {
      let hasPostinstall = 'no  postinstall';
      if (moduleInfo.postinstall) {
        hasPostinstall = 'has postinstall';
      }

      let depsCount = Object.keys(moduleInfo.dependencies).length;
      if (depsCount <= 9) {
        depsCount = `${depsCount} `;
      }
      return `|  ${depsCount} deps  |  ${hasPostinstall}  |  ${moduleInfo.folderName}`;
    });
    return moduleNames.join('\n');
  },

  getModuleDependencies(installedPackets, localPackets, moduleInfo, localPacketsWillBeLinked) {
    const missingDependencies = [];
    const conflictDependencies = [];
    const messages = [];
    let avaliablePackets = installedPackets;

    if (localPacketsWillBeLinked) {
      avaliablePackets = avaliablePackets.concat(localPackets);
    }

    const avaliablePacketNames = avaliablePackets.map((module) => {
      return module.name;
    });

    let avaliableIndex = -1;
    let checkVersion = null;
    let targetRange = null;

    for (const name in moduleInfo.dependencies) {
      avaliableIndex = avaliablePacketNames.indexOf(name);
      targetRange = moduleInfo.dependencies[name];

      if (avaliableIndex >= 0) {
        checkVersion = avaliablePackets[avaliableIndex].version;
        if (!semver.satisfies(checkVersion, targetRange)) {
          conflictDependencies.push(avaliablePackets[avaliableIndex]);
          missingDependencies.push({name: name, version: moduleInfo.dependencies[name]});
          messages.push(`${name} ${checkVersion} is installed, but ${moduleInfo.name} wants ${targetRange}`);
        }
      } else {
        missingDependencies.push({name: name, version: moduleInfo.dependencies[name]});
      }
    }

    return {
      conflicted: conflictDependencies,
      missing: missingDependencies,
      messages: messages,
    };
  },

  // Gets the newly found packets, and the ones that are missing,
  // and removes from the missing the ones that can be found in the
  // newly found packets, and looks which newly found packets
  // need to be kept
  removeAvaliablePackets(installedPackets, missingPackets) {
    const result = {
      missing: [],
      keep: [],
    };
    let installedPacket;
    let missingPacket;
    for (let index = 0; index < installedPackets.length; index++) {
      installedPacket = installedPackets[index];

      for (let missingIndex = 0; missingIndex < missingPackets.length; missingIndex++) {
        missingPacket = missingPackets[missingIndex];

        if (installedPacket.name === missingPacket.name &&
            semver.satisfies(installedPacket.version, missingPacket.version)) {

          result.keep.push(installedPacket);
          missingPackets.splice(missingIndex, 1);
          missingIndex--;
          break;
        }
      }
    }

    result.missing = missingPackets;
    return result;
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

  getPackageNamesFromFolder(location) {
    let moduleFolders;
    let scopedFolders;

    return systools.getFolderNames(location)
    .then((folderNames) => {
      logger.debug('toplevel-foldernames', folderNames);
      moduleFolders = folderNames.filter((folderName) => {
        return folderName.indexOf('@') !== 0;
      });

      scopedFolders = folderNames.filter((folderName) => {
        return folderName.indexOf('@') === 0;
      });
      logger.debug('scoped folders', scopedFolders);

      return Promise.all(scopedFolders.map((scopedFolder) => {
        return systools.getFolderNames(path.join(location, scopedFolder));
      }));
    })
    .then((scopedSubFolders) => {
      logger.debug('scoped subfolders', scopedSubFolders);
      return scopedSubFolders.reduce((installedFolders, subFolders, index) => {
        subFolders = subFolders.map((subFolder) => {
          return path.join(`${scopedFolders[index]}`, subFolder);
        });

        return installedFolders.concat(subFolders);
      }, moduleFolders);
    });
  },
};

module.exports = moduletools;
