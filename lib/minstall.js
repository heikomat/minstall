#!/usr/bin/env node

'use strict';

const os = require('os');
const path = require('path');
const Promise = require('bluebird');
const readline = require('readline');
const logger = require('winston');
const {PackageGraph} = require('package-graph');
const intersect = require('semver-intersect').intersect;
const semver = require('semver');

const packageGraph = new PackageGraph();

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
  return ModuleInfo.loadFromFolder(cwd, '');
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
  logger.debug('deleting installed versions of local modules');
  return Promise.all(moduleInfos.map((moduleInfo) => {
    return systools.delete(path.join(cwd, 'node_modules', moduleInfo.folderName));
  }))
    .then(() => {
      logger.debug('linking local modules to root-node_modules');
      return Promise.all(moduleInfos.map((moduleInfo) => {

        // local modules should be linked using the folder-names they should have,
        // no matter what folder-name they actually have, therefore don't use .realFolderName here
        const targetPath = path.join(cwd, 'node_modules', moduleInfo.folderName);
        const modulePath = path.join(cwd, moduletools.modulesFolder, moduleInfo.realFolderName);
        return systools.link(modulePath, targetPath);
      }));
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

function findOptimalDependencyTargetFolder() {
  // create a list of places where dependencies should go. Remember to not install
  // dependencies that appear in the modules list, except when they won't be linked.
  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      const alreadyInstalledDependencies = result.installedDependencies;

      // Find all dependencies of all modules in the requested versions
      const requestedDepedencies = {};
      for (const module of localModules) {
        for (const dependency in module.dependencies) {
          const requestedVersion = module.dependencies[dependency];
          if (requestedDepedencies[dependency] === undefined) {
            requestedDepedencies[dependency] = {};
          }

          let versionFound = false;
          for (const version in requestedDepedencies[dependency]) {
            let intersection = null;
            try {
              intersection = intersect(requestedVersion, version);
            } catch (error) {
              // the versions didn't intersect. That's ok!
            }

            if (intersection) {
              if (intersection !== version) {
                requestedDepedencies[dependency][intersection] = requestedDepedencies[dependency][version];
                delete requestedDepedencies[dependency][version];
              }

              requestedDepedencies[dependency][intersection].push(module.fullModulePath);
              versionFound = true;
            }
          }

          if (!versionFound) {
            requestedDepedencies[dependency][module.dependencies[dependency]] = [
              module.fullModulePath,
            ];
          }
        }
      }

      // remove all dependencies that are already satisfied by the current installation
      // or that will be satisfied by linked local modules
      for (const requestedDependencyName in requestedDepedencies) {
        for (const requestedDependencyVersionRange in requestedDepedencies[requestedDependencyName]) {

          // check if already installed modules satisfy the dependency
          for (const installedDependency of alreadyInstalledDependencies) {
            if (requestedDependencyName !== installedDependency.name) {
              continue;
            }

            if (!semver.satisfies(installedDependency.version, requestedDependencyVersionRange)) {
              continue;
            }

            for (let i = 0; i < requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange].length; i++) {
              const locationOfRequestingModule = requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange][i];

              const installedModuleLocationParts = installedDependency.location.split(path.sep);
              if (installedModuleLocationParts[installedModuleLocationParts.length - 1] === 'node_modules') {
                installedModuleLocationParts.splice(installedModuleLocationParts.length - 1, 1);
              }

              const locationOfInstalledModule = installedModuleLocationParts.join(path.sep);

              let requestingModuleWouldFindInstalledDependency = false;
              if (locationOfInstalledModule === locationOfRequestingModule) {
                requestingModuleWouldFindInstalledDependency = true;
              }

              if (systools.isChildOf(locationOfRequestingModule, locationOfInstalledModule)) {
                requestingModuleWouldFindInstalledDependency = true;
              }

              if (requestingModuleWouldFindInstalledDependency) {
                const shortenedRequesterLocation = locationOfRequestingModule.substr(cwd.length);
                const shortenedInstalledLocation = installedDependency.location.substr(cwd.length);
                logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' is satisfied by version ${installedDependency.version} in '${shortenedInstalledLocation}'`);
                requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange].splice(i, 1);
                i--;

                if (requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange].length === 0) {
                  delete requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange];
                }
              }
            }
          }

          // check if local modules that will get linked satisfy the dependency
          if (!linkModules) {
            continue;
          }

          for (const localModule of localModules) {
            if (requestedDependencyName !== localModule.name) {
              continue;
            }

            if (!semver.satisfies(localModule.version, requestedDependencyVersionRange)) {
              continue;
            }

            for (const locationOfRequestingModule of requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange]) {
              // if the version matches the local module will satisfy the dependency, because the local modules are always linked to
              // the root node_modules, and are therefore always available (unless shadowed by a submodules differening dependency version???)
              // eg. module 'a' is as version 2.0.0 in ./node_modules and as version 1.0.0 in ./someLocalModule/node_modules and requested again as
              // version 2.0.0 in ./someLocalModule/someLocalSubModule
              const shortenedRequesterLocation = locationOfRequestingModule.substr(cwd.length);
              const shortenedLocalLocation = localModule.location.substr(cwd.length);
              logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' is satisfied by local version ${localModule.version} in '${path.join(shortenedLocalLocation)}'`);
            }
            delete requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange];
          }
        }
      }
      console.log(requestedDepedencies);
    });
}

function installModuleDependencies() {
  return findOptimalDependencyTargetFolder()
    .then((targets) => {
      // targets is an array where each entry has a location and a list of modules that should be installed
      // for each core, start an install process, until all installs are done.
      // when finished, get an updated list of the already installed modules and return it
    });
}

function runPostinstalls(modules, availableDependencies) {
  // for each module (as many in parallel as there are threads)
  // see what dependencies it needs, and if it's not available to
  // the module, link it there from somewhere else (see availableDependencies).
  // after linking, run the postinstall, and remove the links created before
  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      const installedModules = result.installedDependencies;
    });
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

  let localModules;
  let installedModules;
  let moduleInfos;

  checkStartConditions()
    .then(() => {
      return moduletools.getModules(cwd);
    })
    .then((submodules) => {
      moduleInfos = submodules;
      return prepareInstallAsDependency(moduleInfos);
    })
    .then(() => {
      return Promise.all(moduleInfos.map((moduleInfo) => {
        // local modules should be linked using the folder-names they should have,
        // no matter what folder-name they actually have, therefore don't use .realFolderName here
        return systools.delete(path.join(cwd, 'node_modules', moduleInfo.folderName));
      }));
    })
    .then(() => {
      return installModuleDependencies();
    })
    .then((updatedModules) => {
      runPostinstalls();
    })
    .then(() => {
      if (!linkModules) {
        logger.debug('not linking local modules to root-node_modules, linking was disabled via --no-link flag');
        return Promise.resolve();
      }

      return linkModulesToRoot(localModules);
    })
    .then(() => {
      return cleanupInstallAsDependency(moduleInfos);
    });
}

run();
