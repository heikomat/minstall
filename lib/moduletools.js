'use strict';

const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');
const systools = require('./systools');
const ModuleInfo = require('./ModuleInfo');
const semver = require('semver');

const InstalledVersionMismatchError = require('./InstalledVersionMismatchError.js');

const moduletools = {

  modulesFolder: 'modules',
  setModulesFolder(modulesFolder) {
    this.modulesFolder = modulesFolder;
  },

  getModules(rootFolder) {
    if (rootFolder === null || rootFolder === undefined) {
      rootFolder = this.modulesFolder;
    }
    const modulesPath = path.join(process.cwd(), rootFolder);

    return systools.getFolderNames(modulesPath)
      .then((folderNames) => {
        return Promise.all(folderNames.map((folderName) => {
          return this.verifyModule(modulesPath, folderName);
        }));
      })
      .then((moduleNames) => {
        const modules = moduleNames.filter((moduleName) => {
          return moduleName != null;
        });

        return Promise.all(modules.map((moduleName) => {
          return ModuleInfo.loadFromFolder(rootFolder, moduleName);
        }));
      });
  },

  logModules(moduleInfos) {
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
    console.log(`running minstall. modules found: \n${moduleNames.join('\n')}`);
  },

  getModuleDependencies(installedPackets, moduleInfo) {
    const missingDependencies = [];
    const conflictDependencies = [];
    const installedPacketNames = installedPackets.map((module) => {
      return module.name;
    });

    let installedIndex = -1;
    let checkVersion = null;
    let targetRange = null;

    for (let name in moduleInfo.dependencies) {
      installedIndex = installedPacketNames.indexOf(name);
      targetRange = moduleInfo.dependencies[name];

      if (installedIndex >= 0) {
        checkVersion = installedPackets[installedIndex].version;
        if (!semver.satisfies(checkVersion, targetRange)) {
          conflictDependencies.push(installedPackets[installedIndex]);
          missingDependencies.push({name: name, version: moduleInfo.dependencies[name]});
        }
      } else {
        missingDependencies.push({name: name, version: moduleInfo.dependencies[name]});
      }
    }

    return {
      conflicted: conflictDependencies,
      missing: missingDependencies,
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
        missingPacket = missingPackets[index];

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

  installPackets(packets) {

    if (packets.length === 0) {
      return Promise.resolve();
    }

    const identities = packets.map((packet) => {
      return `${packet.name}@"${packet.version}"`;
    });

    return systools.runCommand(`npm install ${identities.join(' ')}`)
      .catch((error) => {

        // This error might just be a warning from npm-install
        process.stdout.write(error.message);
      });
  }

};

module.exports = moduletools;
