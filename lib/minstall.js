#!/usr/bin/env node

'use strict';

const os = require('os');
const path = require('path');
const Promise = require('bluebird');
const readline = require('readline');
const logger = require('winston');

const cwd = process.cwd();

const UncriticalError = require('./UncriticalError.js');
const systools = require('./systools.js');
const moduletools = require('./moduletools.js');
const ModuleInfo = require('./ModuleInfo');

let commandConcatSymbol = ';';
let isInProjectRoot = true;
let localPackage = null;

let installedAsDependency = false;
let dependencyInstallLinkedFolders = [];
let projectFolderName = null;
let linkModules = true;

function logVerbose() {
  return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
}

function logIfInRoot(message) {
  if (message && message.length > 0 && (isInProjectRoot || logVerbose())) {
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

function removeModulesFromPackageList(packageNames, moduleInfos) {
  const moduleFolders = moduleInfos.map((moduleInfo) => {
    return moduleInfo.folderName;
  });

  return packageNames.filter((packageName) => {
    if (moduleFolders.indexOf(packageName) >= 0) {
      logger.debug(`skipping ${packageName}`);
    }
    return !(moduleFolders.indexOf(packageName) >= 0);
  });
}

function checkStartConditions() {
  logger.debug('checking start conditions');
  return Promise.all([
    systools.verifyFolderName(cwd, 'node_modules'),
    getLocalPackageInfo(),
  ])
    .then((results) => {
      const folderName = results[0];
      localPackage = results[1];
      const pathParts = cwd.split(path.sep);
      let parentFolder = pathParts[pathParts.length - 2];
      if (localPackage.isScoped) {
        parentFolder = pathParts[pathParts.length - 3];
      }

      if (parentFolder === 'node_modules') {
        logger.debug('project is in a node_modules folder. It\'s therefore installed as a dependency');
        installedAsDependency = true;
      }

      if (folderName == null) {
        logger.debug('project folder has no node_modules-folder');

        if (!installedAsDependency) {
          logger.debug('project is not in a node_modules folder');
          throw new UncriticalError('minstall started from outside the project-root. aborting.');
        }
      } else {
        logger.debug('project folder has node_modules-folder');
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

      if (isInProjectRoot && !localPackage.dependencies.minstall) {
        throw new UncriticalError('minstall started from outside the project-root. aborting.');
      }
    });
}

function linkModulesToRoot(moduleInfos) {
  logger.debug('linking local modules to root-node_modules');
  return Promise.all(moduleInfos.map((moduleInfo) => {

    // local modules should be linked using the folder-names they should have,
    // no matter what folder-name they actually have, therefore don't use .realFolderName here
    const targetPath = path.join(cwd, 'node_modules', moduleInfo.folderName);
    const modulePath = path.join(cwd, moduletools.modulesFolder, moduleInfo.realFolderName);
    return systools.link(modulePath, targetPath);
  }));
}

function linkRootToModule(moduleFolder) {
  logger.debug('linking root-node_modules to module-node_modules');
  const rootModuleFolder = path.join(cwd, 'node_modules');
  const targetFolder = path.join(cwd, moduletools.modulesFolder, moduleFolder, 'node_modules');
  return systools.link(rootModuleFolder, targetFolder);
}

function installMissingModuleDependencies(moduleFolder, missingDependencies) {
  logger.debug('install missing dependencies');
  const moduleNodeModules = path.join(cwd, moduletools.modulesFolder, moduleFolder, 'node_modules');
  return systools.delete(moduleNodeModules)
    .then(() => {
      return moduletools.installPackets(missingDependencies);
    });
}

function runPostinstall(moduleInfo) {
  if (!moduleInfo.postinstall) {
    logger.debug('won\'t run postinstall because there is no postinstall script');
    return Promise.resolve();
  }

  logger.debug('running postinstall');
  const modulePath = path.join(cwd, moduletools.modulesFolder, moduleInfo.realFolderName);
  return linkRootToModule(moduleInfo.realFolderName)
    .then(() => {

      let command = moduleInfo.postinstall;
      if (command.indexOf('minstall') === 0) {
        command += ' --isChildProcess';
      }
      return systools.runCommand(`cd ${modulePath}${commandConcatSymbol} ${command}`);
    })
    .then(() => {

      return systools.delete(path.join(modulePath, 'node_modules'));
    });
}

function cacheConflictingModules(conflictedDependencies, localModules, moduleFolderName) {

  if (conflictedDependencies.length === 0) {
    logger.debug('there are no conflicting packages, thus nothing needs to be cached');
    return Promise.resolve([]);
  }

  const localModuleNames = localModules.map((module) => {
    return module.name;
  });

  // local modules are linked at the very end of the installation, thus all
  // local modules are "not yet linked"
  let cachedModuleFolders = conflictedDependencies;
  if (linkModules) {
    // don't try to cache away local modules, that will be linked later
    cachedModuleFolders = cachedModuleFolders.filter((module) => {
      return localModuleNames.indexOf(module.name) < 0;
    });
  }

  cachedModuleFolders = cachedModuleFolders.map((dependency) => {
    return dependency.folderName;
  });

  if (cachedModuleFolders.length === 0) {
    logger.debug('there are no conflicting packages, thus nothing needs to be cached');
    return Promise.resolve([]);
  }

  logger.debug('caching conflicting packages:', cachedModuleFolders);
  const rootNodeModules = path.join(cwd, 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleFolderName}_cache`);
  return systools.moveMultiple(cachedModuleFolders, rootNodeModules, cacheFolder)
    .then(() => {
      return cachedModuleFolders;
    });
}

function uncacheConflictingModules(cachedModuleFolders, conflictingModules, moduleFolderName) {

  if (cachedModuleFolders.length === 0 && conflictingModules.length === 0) {
    logger.debug('there are no packages that need to be uncached');
    return Promise.resolve();
  }

  const conflictingModuleFolders = conflictingModules.map((module) => {
    // the conflicting packet was installed into the folderName that it's module-name
    // requires it to have, thus don't use the realFolderName from the conflicting module
    // as this might be a local name, that is not the same
    return module.folderName;
  });

  logger.debug('uncaching previously cached packages');
  const rootNodeModules = path.join(cwd, 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleFolderName}_cache`);
  const moduleFolder = path.join(cwd, moduletools.modulesFolder, moduleFolderName);
  const moduleNodeModules = path.join(moduleFolder, 'node_modules');

  // because of possible local modules, the conflicting modules and the actually cached modules don't have to be the same
  // move all modules that caused conflicts to the module-node_modules, but only uncache the modules that actually got cached
  return systools.moveMultiple(conflictingModuleFolders, rootNodeModules, moduleNodeModules)
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

  logger.debug('persist existing dependencies', packetFolderNames);
  const rootNodeModules = path.join(cwd, 'node_modules');
  const moduleNodeModules = path.join(cwd, moduletools.modulesFolder, moduleFolderName, 'node_modules');
  return systools.moveMultiple(packetFolderNames, moduleNodeModules, rootNodeModules);
}

function installModules(installedModules, moduleInfos, index) {

  if (logVerbose()) {
    process.stdout.write(`\n`);
  }

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

    if (logVerbose()) {
      process.stdout.write(`\n`);
    }

  }

  let packetsToKeep;
  let cachedModuleFolders;
  const deps = moduletools.getModuleDependencies(installedModules, moduleInfos, moduleInfo, linkModules);
  if (deps.messages.length > 0) {
    logVersionConflict(deps.messages, moduleInfo.realFolderName);
  }

  return moduletools.getPreinstalledPacketsEvaluation(moduleInfo.realFolderName, deps.missing)
    .then((result) => {
      packetsToKeep = result.keep;
      logger.debug('keeping the following preinstalled packages:', packetsToKeep.map((packet) => {
        return packet.name;
      }));

      deps.missing = result.missing;
      logger.debug('the following dependencies are missing:', deps.missing);
      return cacheConflictingModules(deps.conflicted, moduleInfos, moduleInfo.realFolderName);
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
      return uncacheConflictingModules(cachedModuleFolders, deps.conflicted, moduleInfo.realFolderName);
    })
    .then(() => {
      return getInstalledModules();
    })
    .then((modules) => {
      return installModules(modules, moduleInfos, moduleIndex + 1);
    });
}

function getParentNodeModules() {
  let parentNodeModules = path.join(cwd, '..');
  if (localPackage.isScoped) {
    parentNodeModules = path.join(parentNodeModules, '..');
  }

  return parentNodeModules;
}

function prepareInstallAsDependency(moduleInfos) {
  if (!installedAsDependency) {
    return Promise.resolve();
  }

  logger.debug('prepare install as dependency');
  const parentNodeModules = getParentNodeModules();

  return systools.mkdir(path.join(cwd, 'node_modules'))
    .then(() => {
      return moduletools.getPackageNamesFromFolder(parentNodeModules);
    })
    .then((packageNames) => {

      dependencyInstallLinkedFolders = removeModulesFromPackageList(packageNames, moduleInfos);
      dependencyInstallLinkedFolders.splice(dependencyInstallLinkedFolders.indexOf(projectFolderName), 1);

      return Promise.all(dependencyInstallLinkedFolders.map((folderName) => {
        systools.link(path.join(parentNodeModules, folderName), path.join(cwd, 'node_modules', folderName));
      }));
    });
}

function cleanupInstallAsDependency(moduleInfos) {
  if (!installedAsDependency) {
    return Promise.resolve();
  }

  const parentNodeModules = getParentNodeModules();

  logger.debug('cleanup after install as dependency');
  return systools.deleteMultiple(dependencyInstallLinkedFolders, path.join(cwd, 'node_modules'))
    .then(() => {
      return moduletools.getPackageNamesFromFolder(path.join(cwd, 'node_modules'));
    })
    .then((packageNames) => {
      logger.debug('installedModuleFolders', packageNames);

      const folderNames = removeModulesFromPackageList(packageNames, moduleInfos);
      logger.debug('folders to move to the parent-node_modules', folderNames);
      return systools.moveMultiple(folderNames, path.join(cwd, 'node_modules'), parentNodeModules);
    })
    .then(() => {
      if (moduleInfos.length > 0) {
        return systools.deleteEmptyFolders(path.join(cwd, 'node_modules'));
      }

      return systools.delete(path.join(cwd, 'node_modules'));
    });
}

function setupLogger() {
  logger.remove(logger.transports.Console);
  logger.add(logger.transports.Console, {
    stderrLevels: ['warn', 'error', 'critial'],
    colorize: true,
    handleExceptions: true,
    humanReadableUnhandledException: true,
    timestamp: false,
    prettyPrint: true,
  });

  const logLevels = {
    critical: {level: 0, color: 'red'},
    error: {level: 1, color: 'magenta'},
    warn: {level: 2, color: 'yellow'},
    info: {level: 3, color: 'green'},
    verbose: {level: 4, color: 'gray'},
    debug: {level: 5, color: 'blue'},
    silly: {level: 6, color: 'cyan'},
  };
  const levels = {};
  const colors = {};

  Object.keys(logLevels)
    .forEach((name) => {
      levels[name] = logLevels[name].level;
      colors[name] = logLevels[name].color;
    });

  logger.setLevels(levels);
  logger.addColors(colors);
}

function run() {
  const startTime = Date.now();

  setupLogger();
  logger.level = 'info';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf('--') !== 0) {
      moduletools.setModulesFolder(process.argv[i]);
    } else if (process.argv[i] === '--isChildProcess') {
      isInProjectRoot = false;
    } else if (process.argv[i] === '--loglevel') {
      logger.level = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === '--no-link') {
      linkModules = false;
    }
  }

  systools.setLogger(logger);
  moduletools.setLogger(logger);

  logger.silly('process arguments:', process.argv);
  logger.silly('os platfrom:', os.platform());
  logger.debug('loglevel:', logger.level);
  logger.debug('isChildProcess:', !isInProjectRoot);
  if (os.platform() === 'win32') {
    commandConcatSymbol = '&';
    moduletools.setNullTarget('NUL');
  }

  const pathParts = cwd.split(path.sep);
  projectFolderName = pathParts[pathParts.length - 1];
  logger.debug('project folder name:', projectFolderName);

  let installedModules;
  let moduleInfos;
  checkStartConditions()
    .then(() => {
      return moduletools.getModules();
    })
    .then((submodules) => {
      moduleInfos = submodules;
      return prepareInstallAsDependency(moduleInfos);
    })
    .then(() => {
      return getInstalledModules();
    })
    .then((modules) => {
      installedModules = modules;
      logger.silly('installed modules:', installedModules.map((module) => { return module.name; }));

      moduleInfos.sort((module1, module2) => {
        if (Object.keys(module1.dependencies).indexOf(module2.name) >= 0) {
          return 1;
        }

        if (Object.keys(module2.dependencies).indexOf(module1.name) >= 0) {
          return -1;
        }

        return 0;
      });

      logger.debug('found local modules:', moduleInfos.map((module) => { return module.name; }));
      if (moduleInfos.length === 0) {
        throw new UncriticalError('no modules found, thus minstall is done :)');
      }

      let moduleText = 'modules';
      if (moduleInfos.length === 1) {
        moduleText = 'module';
      }

      logIfInRoot(`minstall found ${moduleInfos.length} local ${moduleText} in '${moduletools.modulesFolder}'`);
      logger.debug('deleting previously linked local modules');
      return Promise.all(moduleInfos.map((moduleInfo) => {
        // local modules should be linked using the folder-names they should have,
        // no matter what folder-name they actually have, therefore don't use .realFolderName here
        return systools.delete(path.join(cwd, 'node_modules', moduleInfo.folderName));
      }));
    })
    .then(() => {
      logger.debug('install local modules');
      return installModules(installedModules, moduleInfos);
    })
    .then(() => {
      if (!linkModules) {
        logger.debug('not linking local modules to root-node_modules, linking was disabled via --no-link flag');
        return Promise.resolve();
      }

      return linkModulesToRoot(moduleInfos);
    })
    .then(() => {
      return cleanupInstallAsDependency(moduleInfos);
    })
    .then(() => {
      logIfInRoot(`\nminstall finished in ${systools.getRuntime(startTime)} :)\n\n`);
    })
    .catch(UncriticalError, (error) => {
      logIfInRoot(error.message);
    });
}

run();
