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

      // remove all dependencies that are already satisfied by the current
      // installation or will be satisfied by linked local modules
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

            for (const locationOfRequestingModule of requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange]) {
              // It doesn't matter where the dependency with the correct version is! all shadowed dependencies
              // get fixed with symlinks after the installation!
              const shortenedRequesterLocation = locationOfRequestingModule.substr(cwd.length);
              const shortenedInstalledLocation = installedDependency.location.substr(cwd.length);
              logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by installed version ${installedDependency.version} in '${path.join(shortenedInstalledLocation)}'`);
            }

            delete requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange];
            break;
          }

          if (!requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange] ||
              requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange].length === 0) {
            delete requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange];
            continue;
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
              // if the version matches the local module will satisfy the dependency, because even if it would get shadowed,
              // shadowed dependencies will get fixed with symlinks!
              const shortenedRequesterLocation = locationOfRequestingModule.substr(cwd.length);
              const shortenedLocalLocation = localModule.location.substr(cwd.length);
              logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by local version ${localModule.version} in '${path.join(shortenedLocalLocation)}'`);
            }
            delete requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange];
            break;
          }
        }
        if (Object.keys(requestedDepedencies[requestedDependencyName]).length === 0) {
          delete requestedDepedencies[requestedDependencyName];
        }
      }

      // now we know exactly what dependencies are missing where
      // next: calculate the optimal installation-folders, so that as few installs
      // as possible are done
      // the optimal folder is as close to the root folder as possible without
      // causing version conflicts within a folder.
      // To achieve this we start at the root-folder, and go deeper until we
      // find a folder that has no conflicting dependencies

      // First we make a 2d-array out of the requestedDepedencies-object.
      // This allowes us to sort every dependency by occurence-count, and withing
      // that by folder-depth. doing so minimizes the number of required installs
      let requestedDependencyArray = [];
      for (const requestedDependencyName in requestedDepedencies) {
        for (const requestedDependencyVersionRange in requestedDepedencies[requestedDependencyName]) {
          requestedDependencyArray.push({
            name: requestedDependencyName,
            versionRange: requestedDependencyVersionRange,
            identifier: `${requestedDependencyName}@"${requestedDependencyVersionRange}"`,
            requestedBy: requestedDepedencies[requestedDependencyName][requestedDependencyVersionRange],
          });
        }
      }

      // sort by number of requests, so the most requested dependencies will
      // get installed closer to the root
      requestedDependencyArray = requestedDependencyArray.sort((requestedDependency1, requestedDependency2) => {
        return requestedDependency2.requestedBy.length - requestedDependency1.requestedBy.length;
      });

      const optimalDependencyTargetFolder = {};
      for (const requestedDependency of requestedDependencyArray) {

        // it doesn't matter where the dependency gets Installed, even if mutliple
        // modules need it, because in that case it will be symlinked from wherever
        // it is installed. Because of this we just work with the path of the first
        // module that requests this dependency
        const possiblePathElements = requestedDependency.requestedBy[0].substr(cwd.length).split(path.sep).filter((pathElement) => {
          return pathElement.length > 0;
        });

        // because we check the current path first, and then add the path element, the last element won't be checked.
        // because of that we just add another pathElement that will be ignored, but will make the last real
        // pathElement not be ignored
        possiblePathElements.push('');
        let currentPath = cwd;

        for (const possiblePathElement of possiblePathElements) {
          // is this Dependency already on the list of things to install?
          let installModuleHere = true;
          for (const modulePath in optimalDependencyTargetFolder) {
            const modulesToBeInstalled = optimalDependencyTargetFolder[modulePath];
            const matchingModule = modulesToBeInstalled.find((moduleToBeInstalled) => {
              return moduleToBeInstalled.identifier === requestedDependency.identifier;
            });

            if (matchingModule) {
              logger.debug(`no need to install ${requestedDependency.identifier} to ${currentPath}. a matching version will already be installed to ${modulePath}`);
              installModuleHere = false;
              break;
            }
          }

          // Is a conflicting dependency-version already installed here?
          if (installModuleHere) {
            for (const installedDependency of alreadyInstalledDependencies) {
              if (installedDependency.name === requestedDependency.name &&
                  installedDependency.location === path.join(currentPath, 'node_modules')) {
                logger.debug(`${requestedDependency.identifier} can't be installed to ${currentPath}. it conflicts with the already installed ${installedDependency.name}@"${installedDependency.version}"`);
                installModuleHere = false;
                break;
              }
            }
          }

          // will any conflicting dependency-versions be installed here?
          // this didn't work for node8/6
          if (installModuleHere && optimalDependencyTargetFolder[currentPath]) {
            const conflictingDependency = optimalDependencyTargetFolder[currentPath].find((toBeInstalledDependency) => {
              return toBeInstalledDependency.name === requestedDependency.name &&
                      toBeInstalledDependency.versionRange !== requestedDependency.versionRange;
            });

            if (conflictingDependency) {
              logger.debug(`${requestedDependency.identifier} can't be installed to ${currentPath}. it'd conflict with the to be installed ${conflictingDependency.identifier}`);
              installModuleHere = false;
            }
          }

          if (!installModuleHere) {
            currentPath = path.join(currentPath, possiblePathElement);
            continue;
          }

          logger.debug(`found a place to install ${requestedDependency.identifier}: ${currentPath}`);

          // the dependency can be installed here :)
          if (!optimalDependencyTargetFolder[currentPath]) {
            optimalDependencyTargetFolder[currentPath] = [];
          }

          optimalDependencyTargetFolder[currentPath].push(requestedDependency);
          break;
        }
      }

      return optimalDependencyTargetFolder;
    });
}

function fixMissingDependenciesWithSymlinks() {

  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      const installedDependencies = result.installedDependencies;
      const symlinkPromises = [];

      for (const module of localModules) {
        for (const dependency in module.dependencies) {
          // check if the dependency is already installed localy
          let dependencyAlreadyInstalled = false;
          let fittingInstalledModule = null;
          for (const installedModule of installedDependencies) {
            if (installedModule.name !== dependency) {
              continue;
            }

            if (installedModule.location === path.join(module.fullModulePath, 'node_modules')) {
              fittingInstalledModule = installedModule;
              dependencyAlreadyInstalled = true;
              break;
            } else if (semver.satisfies(installedModule.version, module.dependencies[dependency])) {
              fittingInstalledModule = installedModule;
            }
          }

          // when no installed module was found, see if a local module fits the dependency
          // but only if local modules are supposed to be linked
          if (!fittingInstalledModule && linkModules) {
            for (const localModule of localModules) {
              if (localModule.name !== dependency ||
                !semver.satisfies(localModule.version, module.dependencies[dependency])) {
                if (localModule.name === dependency) {
                  console.log(`semver mismatch for ${dependency} ON ${module.fullModulePath}: wanted ${module.dependencies[dependency]}, got ${localModule.version} in ${localModule.fullModulePath}`);
                }
                continue;
              }

              fittingInstalledModule = localModule;
              break;
            }
          }

          if (!dependencyAlreadyInstalled) {
            if (!fittingInstalledModule) {
              logger.warn(`NO INSTALLATION FOUND FOR DEPENDENCY ${dependency} ON ${module.fullModulePath}. This can happen when the version of a dependency is a github-url`);
            } else {
              symlinkPromises.push(systools.link(fittingInstalledModule.fullModulePath, path.join(module.fullModulePath, 'node_modules', fittingInstalledModule.folderName)));
            }
          }
        }
      }

      return Promise.all(symlinkPromises);
    });
}

function installModuleDependencies() {
  return findOptimalDependencyTargetFolder()
    .then((targets) => {

      // targets is an array where each entry has a location and a list of modules that should be installed
      const installPromises = [];

      for (const targetFolder in targets) {
        installPromises.push(moduletools.installPackets(targetFolder, targets[targetFolder]));
      }

      return Promise.all(installPromises);
    })
    .then(() => {
      // Now we're in a state where every dependency required by any local module
      // is installed at least somewhere. To make the modules find their dependencies
      // we now symlink them to the modules
      return fixMissingDependenciesWithSymlinks();

      // TODO: delete all unnecessary double-installs (when a and b both had a sub-dependency c that thus got installed twice)
    });
}

function runPostinstalls(modules, availableDependencies) {
  // for each module (as many in parallel as there are threads)
  // see what dependencies it needs, and if it's not available to
  // the module, link it there from somewhere else (see availableDependencies).
  // after linking, run the postinstall, and remove the links created before
  /*
  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      const installedModules = result.installedDependencies;
    });
  */
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
    moduletools.setCommandConcatSymbol(commandConcatSymbol);
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
      console.log('installs done!', systools.getRuntime(startTime));
      runPostinstalls();
    })
    .then(() => {
      return cleanupInstallAsDependency(moduleInfos);
    });
}

run();
