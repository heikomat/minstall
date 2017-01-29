#!/usr/bin/env node

'use strict';

const os = require('os');
const path = require('path');
const Promise = require('bluebird');
const readline = require('readline');

const cwd = process.cwd();

const UncriticalError = require('./UncriticalError.js');
const systools = require('./systools.js');
const moduletools = require('./moduletools.js');
const ModuleInfo = require('./ModuleInfo');

let commandConcatSymbol = ';';
let isInProjectRoot = true;

let installedAsDependency = false;
let dependencyInstallLinkedFolders = [];
let projectFolderName = null;

function logIfInRoot(message) {
  if (isInProjectRoot) {
    console.log(message);
  }
}

function logVersionConflict(messages, moduleFolderName) {

  const moduleFolder = path.join(cwd, moduletools.modulesFolder, moduleFolderName);
  console.log(`

| UNCRITICAL DEPENDENCY-CONFLICTS FOUND:
|   ${messages.join('\n|   ')}
| 
| This is not an error, but consider using compatible package-versions
| throughout the whole project.`);
}

function getLocalPackageInfo() {
  return ModuleInfo.loadFromFolder('', '');
}

function getInstalledModules() {
  return moduletools.getModules('node_modules');
}

function checkStartConditions() {
  return systools.verifyFolderName(cwd, 'node_modules')
    .then((folderName) => {
      if (folderName == null) {

        const pathParts = cwd.split(path.sep);
        if (pathParts[pathParts.length - 2] !== 'node_modules') {
          throw new UncriticalError('minstall started from outside the project-root. aborting.');
        } else {
          installedAsDependency = true;
        }
      }

      if (moduletools.modulesFolder === '.') {
        return Promise.resolve('.');
      }
      return systools.verifyFolderName(cwd, moduletools.modulesFolder);
    })
    .then((folderName) => {
      if (folderName == null) {
        throw new UncriticalError(`${moduletools.modulesFolder} not found, thus minstall is done :)`);
      }

      if (installedAsDependency) {
        return null;
      }

      return Promise.all([
        systools.isSymlink(path.join(cwd, 'node_modules')),
        getLocalPackageInfo(),
      ]);
    })
    .then((results) => {

      if (installedAsDependency) {
        return;
      }

      if (isInProjectRoot) {
        isInProjectRoot = !results[0];
      }

      if (isInProjectRoot && !results[1].dependencies.minstall) {
        throw new UncriticalError('minstall started from outside the project-root. aborting.');
      }
    });
}

function linkModulesToRoot(moduleInfos) {
  return Promise.all(moduleInfos.map((moduleInfo) => {

    // local modules should be linked using the folder-names they should have,
    // no matter what folder-name they actually have, therefore don't use .realFolderName here
    const targetPath = path.join(cwd, 'node_modules', moduleInfo.folderName);
    const modulePath = path.join(cwd, moduletools.modulesFolder, moduleInfo.realFolderName);
    return systools.link(modulePath, targetPath);
  }));
}

function linkRootToModule(moduleFolder) {
  const rootModuleFolder = path.join(cwd, 'node_modules');
  const targetFolder = path.join(cwd, moduletools.modulesFolder, moduleFolder, 'node_modules');
  return systools.link(rootModuleFolder, targetFolder);
}

function installMissingModuleDependencies(moduleFolder, missingDependencies) {
  const moduleNodeModules = path.join(cwd, moduletools.modulesFolder, moduleFolder, 'node_modules');
  return systools.delete(moduleNodeModules)
    .then(() => {
      return moduletools.installPackets(missingDependencies);
    });
}

function runPostinstall(moduleInfo) {
  if (!moduleInfo.postinstall) {
    return Promise.resolve();
  }

  const modulePath = path.join(cwd, moduletools.modulesFolder, moduleInfo.realFolderName);
  return linkRootToModule(moduleInfo.realFolderName)
    .then(() => {

      let command = moduleInfo.postinstall;
      if (command.indexOf('minstall') === 0) {
        command += ' isChildProcess';
      }
      return systools.runCommand(`cd ${modulePath}${commandConcatSymbol} ${command}`);
    })
    .then(() => {

      return systools.delete(path.join(modulePath, 'node_modules'));
    });
}

function cacheConflictingModules(conflictedDependencies, notYetLinkedLocalModules, moduleFolderName) {

  if (conflictedDependencies.length === 0) {
    return Promise.resolve([]);
  }

  const notYetLinkedLocalModuleNames = notYetLinkedLocalModules.map((module) => {
    return module.name;
  });

  console.log('not yet linked local module names', notYetLinkedLocalModuleNames);
  const cachedModuleFolders = conflictedDependencies.filter((module) => {
    return notYetLinkedLocalModuleNames.indexOf(module.name) < 0;
  })
  .map((dependency) => {
    return dependency.folderName;
  });

  if (cachedModuleFolders.length === 0) {
    return Promise.resolve([]);
  }

  const rootNodeModules = path.join(cwd, 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleFolderName}_cache`);
  return systools.moveMultiple(cachedModuleFolders, rootNodeModules, cacheFolder)
    .then(() => {
      return cachedModuleFolders;
    });
}

function uncacheConflictingModules(cachedModuleFolders, moduleFolderName) {

  if (cachedModuleFolders.length === 0) {
    return Promise.resolve();
  }

  const rootNodeModules = path.join(cwd, 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleFolderName}_cache`);
  const moduleFolder = path.join(cwd, moduletools.modulesFolder, moduleFolderName);
  const moduleNodeModules = path.join(moduleFolder, 'node_modules');

  return systools.moveMultiple(cachedModuleFolders, rootNodeModules, moduleNodeModules)
    .then(() => {

      return systools.moveMultiple(cachedModuleFolders, cacheFolder, rootNodeModules);
    })
    .then(() => {

      return systools.delete(path.join(cacheFolder));
    });
}

function persistExistingConfilctingDependencies(packetsToKeep, moduleFolderName) {

  const packetFolderNames = packetsToKeep.map((packet) => {
    return packet.folderName;
  });

  const rootNodeModules = path.join(cwd, 'node_modules');
  const moduleNodeModules = path.join(cwd, moduletools.modulesFolder, moduleFolderName, 'node_modules');
  return systools.moveMultiple(packetFolderNames, moduleNodeModules, rootNodeModules);
}

function installModules(installedModules, moduleInfos, index) {

  const moduleIndex = index || 0;
  if (moduleIndex >= moduleInfos.length) {
    return Promise.resolve();
  }

  if (moduleIndex > 0 && isInProjectRoot) {
    readline.clearLine(process.stdout);
    readline.cursorTo(process.stdout, 0);
  }

  const moduleInfo = moduleInfos[moduleIndex];
  if (isInProjectRoot) {
    let moduleNumber = moduleIndex + 1;
    if (moduleInfos.length > 9 && moduleNumber <= 9) {
      moduleNumber = `0${moduleNumber}`;
    }
    process.stdout.write(`installing module ${moduleNumber}/${moduleInfos.length} -> ${moduleInfo.realFolderName} `);
  }

  let packetsToKeep;
  let cachedModuleFolders;
  const deps = moduletools.getModuleDependencies(installedModules, moduleInfos, moduleInfo);
  if (deps.messages.length > 0) {
    logVersionConflict(deps.messages, moduleInfo.realFolderName);
  }

  return moduletools.getPreinstalledPacketsEvaluation(moduleInfo.realFolderName, deps.missing)
    .then((result) => {
      packetsToKeep = result.keep;
      deps.missing = result.missing;
      return cacheConflictingModules(deps.conflicted, moduleInfos.slice(index), moduleInfo.realFolderName);
    })
    .then((newlyCachedModuleFolders) => {
      cachedModuleFolders = newlyCachedModuleFolders;
      return persistExistingConfilctingDependencies(packetsToKeep, moduleInfo.realFolderName);
    })
    .then(() => {
      return installMissingModuleDependencies(moduleInfo.realFolderName, deps.missing);
    })
    .then(() => {
      return runPostinstall(moduleInfo);
    })
    .then(() => {
      return uncacheConflictingModules(cachedModuleFolders, moduleInfo.realFolderName);
    })
    .then(() => {
      return getInstalledModules();
    })
    .then((modules) => {
      return installModules(modules, moduleInfos, moduleIndex + 1);
    });
}

function prepareInstallAsDependency() {
  if (!installedAsDependency) {
    return Promise.resolve();
  }

  return systools.mkdir(path.join(cwd, 'node_modules'))
    .then(() => {
      return systools.getFolderNames(path.join(cwd, '..'));
    })
    .then((folderNames) => {
      dependencyInstallLinkedFolders = folderNames;
      dependencyInstallLinkedFolders.splice(dependencyInstallLinkedFolders.indexOf(projectFolderName), 1);

      return Promise.all(dependencyInstallLinkedFolders.map((folderName) => {
        systools.link(path.join(cwd, '..', folderName), path.join(cwd, 'node_modules', folderName));
      }));
    });
}

function cleanupInstallAsDependency() {
  if (!installedAsDependency) {
    return Promise.resolve();
  }

  return systools.deleteMultiple(dependencyInstallLinkedFolders, path.join(cwd, 'node_modules'))
    .then(() => {
      return systools.getFolderNames(path.join(cwd, 'node_modules'));
    })
    .then((folderNames) => {
      return systools.moveMultiple(folderNames, path.join(cwd, 'node_modules'), path.join(cwd, '..'));
    })
    .then(() => {
      return systools.delete(path.join(cwd, 'node_modules'));
    });
}

function run() {
  const startTime = Date.now();
  if (process.argv[2] && process.argv[2] !== 'isChildProcess') {
    moduletools.setModulesFolder(process.argv[2]);
  }

  if (process.argv.indexOf('isChildProcess') === process.argv.length - 1) {
    isInProjectRoot = false;
  }

  if (os.platform() === 'win32') {
    commandConcatSymbol = '&';
    moduletools.setNullTarget('NUL');
  }

  const pathParts = cwd.split(path.sep);
  projectFolderName = pathParts[pathParts.length - 1];

  let installedModules;
  let moduleInfos;
  checkStartConditions()
    .then(() => {
      return prepareInstallAsDependency();
    })
    .then(() => {
      return Promise.all([
        getInstalledModules(),
        moduletools.getModules(),
      ]);
    })
    .then((modules) => {
      installedModules = modules[0];
      moduleInfos = modules[1];
      moduleInfos.sort((module1, module2) => {
        if (Object.keys(module1.dependencies).indexOf(module2.name) >= 0) {
          return 1;
        }

        if (Object.keys(module2.dependencies).indexOf(module1.name) >= 0) {
          return -1;
        }

        return 0;
      });

      if (moduleInfos.length === 0) {
        throw new UncriticalError('no modules found, thus minstall is done :)');
      }

      let moduleText = 'modules';
      if (moduleInfos.length === 1) {
        moduleText = 'module';
      }
      logIfInRoot(`minstall found ${moduleInfos.length} local ${moduleText} in '${moduletools.modulesFolder}'`);
      return Promise.all(moduleInfos.map((moduleInfo) => {
        // local modules should be linked using the folder-names they should have,
        // no matter what folder-name they actually have, therefore don't use .realFolderName here
        return systools.delete(path.join(cwd, 'node_modules', moduleInfo.folderName));
      }));
    })
    .then(() => {
      return installModules(installedModules, moduleInfos);
    })
    .then(() => {
      return this.linkModulesToRoot(moduleInfos);
    })
    .then(() => {
      return cleanupInstallAsDependency();
    })
    .then(() => {
      logIfInRoot(`\nminstall finished in ${systools.getRuntime(startTime)} :)\n\n`);
    })
    .catch(UncriticalError, (error) => {
      logIfInRoot(error.message);
    });
}

run();
