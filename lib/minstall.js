#!/usr/bin/env node

'use strict';

const os = require('os');
const path = require('path');
const Promise = require('bluebird');
const readline = require('readline');
const logger = require('winston');
const intersect = require('semver-intersect').intersect;
const semver = require('semver');

const cwd = process.cwd();

const UncriticalError = require('./UncriticalError.js');
const systools = require('./systools.js');
const moduletools = require('./moduletools.js');
const ModuleInfo = require('./ModuleInfo');

let commandConcatSymbol = ';';
let isInProjectRoot = true;
let localPackage = null;

let installedAsDependency = false;
const dependencyInstallLinkedFolders = [];
let projectFolderName = null;
let linkModules = true;
let npmVersion = null;
let cleanup = false;
let dependencyCheckOnly = false;

function logVerbose() {
  return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
}

function logIfInRoot(message) {
  if (message && message.length > 0 && (isInProjectRoot || logVerbose())) {
    console.log(message);
  }
}

function getLocalPackageInfo() {
  return ModuleInfo.loadFromFolder(cwd, '');
}

function checkStartConditions() {
  logger.debug('checking start conditions');
  return Promise.all([
    systools.verifyFolderName(cwd, 'node_modules'),
    getLocalPackageInfo(),
    systools.runCommand('npm --version'),
  ])
    .then((results) => {
      const folderName = results[0];
      localPackage = results[1];
      npmVersion = results[2];

      // npm 5 workaround until npm-issue #16853 is fixed
      if (semver.major(npmVersion) === 5) {
        logger.info('npm 5 detected. forcing --cleanup');
        cleanup = true;
      }

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

function findRequestedDependencies(localModules) {
  const requestedDependencies = {};
  for (const module of localModules) {
    for (const dependency in module.dependencies) {
      const requestedVersion = module.dependencies[dependency];
      if (requestedDependencies[dependency] === undefined) {
        requestedDependencies[dependency] = {};
      }

      let versionFound = false;
      for (const version in requestedDependencies[dependency]) {
        let intersection = null;
        try {
          intersection = intersect(requestedVersion, version);
        } catch (error) {
          // the versions didn't intersect. That's ok!
        }

        if (intersection) {
          if (intersection !== version) {
            requestedDependencies[dependency][intersection] = requestedDependencies[dependency][version];
            delete requestedDependencies[dependency][version];
          }

          requestedDependencies[dependency][intersection].push(module.fullModulePath);
          versionFound = true;
        }
      }

      if (!versionFound) {
        requestedDependencies[dependency][module.dependencies[dependency]] = [
          module.fullModulePath,
        ];
      }
    }
  }

  return requestedDependencies;
}

function removeAlreadySatisfiedDependencies(requestedDependencies, localModules, alreadyInstalledDependencies) {
  const result = Object.assign({}, requestedDependencies);
  for (const requestedDependencyName in result) {
    for (const requestedDependencyVersionRange in result[requestedDependencyName]) {

      // check if already installed modules satisfy the dependency
      // TODO: if the dependency is found in root, we might want to install
      // it later anyway, even if it is already installed there, because that
      // way we'd have a single, complete 'npm install' per folder, which
      // in turn might make minstall compatible to npm 5
      for (const installedDependency of alreadyInstalledDependencies) {
        if (requestedDependencyName !== installedDependency.name) {
          continue;
        }

        if (!semver.satisfies(installedDependency.version, requestedDependencyVersionRange)) {
          continue;
        }

        for (const locationOfRequestingModule of result[requestedDependencyName][requestedDependencyVersionRange]) {
          // It doesn't matter where the dependency with the correct version is! all shadowed dependencies
          // get fixed with symlinks after the installation!
          const shortenedRequesterLocation = locationOfRequestingModule.substr(cwd.length);
          const shortenedInstalledLocation = installedDependency.location.substr(cwd.length);
          logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by installed version ${installedDependency.version} in '${path.join(shortenedInstalledLocation)}'`);
        }

        delete result[requestedDependencyName][requestedDependencyVersionRange];
        break;
      }

      if (!result[requestedDependencyName][requestedDependencyVersionRange] ||
        result[requestedDependencyName][requestedDependencyVersionRange].length === 0) {
        delete result[requestedDependencyName][requestedDependencyVersionRange];
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

        for (const locationOfRequestingModule of result[requestedDependencyName][requestedDependencyVersionRange]) {
          // if the version matches the local module will satisfy the dependency, because even if it would get shadowed,
          // shadowed dependencies will get fixed with symlinks!
          const shortenedRequesterLocation = locationOfRequestingModule.substr(cwd.length);
          const shortenedLocalLocation = localModule.location.substr(cwd.length);
          logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by local version ${localModule.version} in '${path.join(shortenedLocalLocation)}'`);
        }
        delete result[requestedDependencyName][requestedDependencyVersionRange];
        break;
      }
    }
    if (Object.keys(result[requestedDependencyName]).length === 0) {
      delete result[requestedDependencyName];
    }
  }

  return result;
}

function dependenciesToArray(dependencies) {
  const result = [];

  for (const dependencyName in dependencies) {
    for (const dependencyVersionRange in dependencies[dependencyName]) {
      result.push({
        name: dependencyName,
        versionRange: dependencyVersionRange,
        identifier: `${dependencyName}@"${dependencyVersionRange}"`,
        requestedBy: dependencies[dependencyName][dependencyVersionRange],
      });
    }
  }

  return result;
}

function determineDependencyTargetFolder(requestedDependencyArray, alreadyInstalledDependencies) {

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
}

function sortDependenciesByRequestCount(requestedDependencyArray) {
  const result = requestedDependencyArray.splice(0).sort((requestedDependency1, requestedDependency2) => {
    return requestedDependency2.requestedBy.length - requestedDependency1.requestedBy.length;
  });

  return result;
}

function printNonOptimalDependencyInfos(requestedDependencies) {
  let requestedDependencyArray = dependenciesToArray(requestedDependencies);
  requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);
  let initialMessagePrinted = false;

  for (const requestedDependencyName in requestedDependencies) {
    if (Object.keys(requestedDependencies[requestedDependencyName]).length < 2) {
      continue;
    }

    if (!initialMessagePrinted) {
      logIfInRoot('┌---------------------------------------');
      logIfInRoot('| NON-OPTIMAL DEPENDENCY-SETUP DETECTED!');
      initialMessagePrinted = true;
    }

    // find the most requested version
    const requestedVersions = requestedDependencyArray.filter((dependency) => {
      return dependency.name === requestedDependencyName;
    });

    const mostRequested = requestedVersions.splice(0, 1)[0];
    const requestedByOtherPackagesString = requestedVersions.map((requestedVersion) => {
      const requestedByString = requestedVersion.requestedBy.map((requestedByPath) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n|     ');

      return `|   version ${requestedVersion.versionRange} is requested by ${requestedVersion.requestedBy.length} local modules:
|     ${requestedByString}`;
    }).join('\n| ');

    logIfInRoot(`|
|
| ${mostRequested.requestedBy.length} local modules want version ${mostRequested.versionRange} of ${mostRequested.name}, but some don't:
${requestedByOtherPackagesString}`);
  }

  if (initialMessagePrinted) {
    logIfInRoot('└---------------------------------------');
    logIfInRoot(' ');
  } else {
    logIfInRoot('No suboptimal dependencies found');
  }
}

function removeContradictingInstalledDependencies() {
  // remove all packages that contradict a modules package.json.
  // for example: module A requires B in version 2.0.0, and in
  // A/node_modules is a package B, but it is in version 1.0.0.
  // In that case, delete A/node_modules/B
  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {

      const deletionPromises = [];
      const localModules = result.modules;
      const alreadyInstalledDependencies = result.installedDependencies;

      for (const module of localModules) {
        for (const dependency in module.dependencies) {
          const requestedVersion = module.dependencies[dependency];
          const dependencyFolder = path.join(module.fullModulePath, 'node_modules');

          const matchingInstalledDependency = alreadyInstalledDependencies.find((installedDependency) => {
            return installedDependency.location === dependencyFolder && installedDependency.name === dependency;
          });

          // The requested dependency is not yet installed, so it can't contradict the version requested
          // in the package.json of the module
          if (matchingInstalledDependency === undefined || matchingInstalledDependency === null) {
            continue;
          }

          // The requested dependency is installed, but its version satisfied the version requested
          // in the package.json of the module, so we don't need to remove it.
          if (semver.satisfies(matchingInstalledDependency.version, requestedVersion)) {
            continue;
          }

          // The requested dependency is installed AND it does not satisfy the version requested
          // in the package.json of the module. We need to remove it!
          logger.debug(`${module.name} wants ${dependency}@${requestedVersion}, but it has version ${matchingInstalledDependency.version} installed in its node_modules. Deleting the contradicting dependency!`);
          deletionPromises.push(systools.delete(matchingInstalledDependency.fullModulePath));
        }
      }

      return Promise.all(deletionPromises);
    });
}

function findOptimalDependencyTargetFolder() {
  // create a list of places where dependencies should go. Remember to not install
  // dependencies that appear in the modules list, except when they won't be linked.

  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      const alreadyInstalledDependencies = result.installedDependencies;

      // Find all dependencies of all modules in the requested versions
      let requestedDependencies = findRequestedDependencies(localModules);

      printNonOptimalDependencyInfos(requestedDependencies);

      // remove all dependencies that are already satisfied by the current
      // installation or will be satisfied by linked local modules
      requestedDependencies = removeAlreadySatisfiedDependencies(requestedDependencies, localModules, alreadyInstalledDependencies);

      // now we know exactly what dependencies are missing where
      // next: calculate the optimal installation-folders, so that as few installs
      // as possible are done. The optimal folder is as close to the root folder
      // as possible without causing version conflicts within a folder.
      // To achieve this we start at the root-folder, and go deeper until we
      // find a folder that has no conflicting dependencies

      // First we make an array out of the requestedDependencies-object, so we
      // can sort the dependencies by the number of requests
      let requestedDependencyArray = dependenciesToArray(requestedDependencies);
      requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);

      return determineDependencyTargetFolder(requestedDependencyArray, alreadyInstalledDependencies);
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
          // this overwrites otherwise found dependencies if they are not installed
          // directly in the modules node_modules-folder
          // in short, the order is: direct install > local module > indirect install
          if ((!fittingInstalledModule || !dependencyAlreadyInstalled) && linkModules) {
            for (const localModule of localModules) {
              if (localModule.name !== dependency ||
                !semver.satisfies(localModule.version, module.dependencies[dependency])) {
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
              // simlink the dependency
              const sourceDependencyPath = fittingInstalledModule.fullModulePath;
              const targetDependencyPath = path.join(module.fullModulePath, 'node_modules', fittingInstalledModule.folderName);
              symlinkPromises.push(systools.link(sourceDependencyPath, targetDependencyPath));

              // create all the .bin-symlinks
              // TODO: this won't work for packets that define a custom bin-folder.
              // This is so super-rare though, that it's not important for now
              for (const binEntry in fittingInstalledModule.bin) {
                const sourceFile = path.join(fittingInstalledModule.fullModulePath, fittingInstalledModule.bin[binEntry]);
                const targetLink = path.join(module.fullModulePath, 'node_modules', '.bin', binEntry);
                symlinkPromises.push(systools.link(sourceFile, targetLink));
              }
            }
          }
        }
      }

      return Promise.all(symlinkPromises);
    });
}

function printInstallationStatus(startedInstallationCount, finishedInstallations) {
  readline.clearLine(process.stdout);
  readline.cursorTo(process.stdout, 0);
  const installationStatus = [];
  for (let index = 0; index < startedInstallationCount; index++) {
    if (finishedInstallations.indexOf(index) >= 0) {
      installationStatus.push(`${index + 1}: ✓`);
    } else {
      installationStatus.push(`${index + 1}:  `);
    }
  }
  process.stdout.write(installationStatus.join(' '));
}

function installModuleDependencies() {

  return removeContradictingInstalledDependencies()
    .then(() => {
      return findOptimalDependencyTargetFolder();
    })
    .then((targets) => {

      // targets is an array where each entry has a location and a list of modules that should be installed
      const installPromises = [];

      let startedInstallationCount = 0;
      const finishedInstallations = [];
      for (const targetFolder in targets) {

        const shortTargetFolder = `.${targetFolder.substr(process.cwd().length)}`;
        const installationIndex = startedInstallationCount;
        startedInstallationCount++;

        logIfInRoot(`${installationIndex + 1}. installing ${targets[targetFolder].length} dependencies to ${shortTargetFolder}`);
        installPromises.push(moduletools.installPackets(targetFolder, targets[targetFolder])
          .then(() => {
            finishedInstallations.push(installationIndex);
            printInstallationStatus(startedInstallationCount, finishedInstallations);
          }));
      }
      printInstallationStatus(targets.length, []);

      return Promise.all(installPromises);
    })
    .then(() => {
      process.stdout.write('\n');
      // Now we're in a state where every dependency required by any local module
      // is installed at least somewhere. To make the modules find their dependencies
      // we now symlink them to the modules
      return fixMissingDependenciesWithSymlinks();

      // TODO: delete all unnecessary double-installs (when a and b both had a sub-dependency c that thus got installed twice)
      // this has low priority, as this is a rare edge-case with no real negative side-effects except a tiny bit bigger folder-size
    });
}

function runPostinstalls(modules) {
  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      const postinstallPromises = [];

      for (const module of localModules) {
        if (!module.postinstall) {
          logger.debug(`skipping the postinstall of ${module.name}. it has no postinstall script.`);
          continue;
        }

        logger.debug(`running postinstall of ${module.name}`);
        postinstallPromises.push(systools.runCommand(`cd ${module.fullModulePath}${commandConcatSymbol} ${module.postinstallmmand}`));
      }

      return Promise.all(postinstallPromises);
    });
}

function deleteLinkedLocalModules() {
  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((moduleInfos) => {
      return Promise.all(moduleInfos.modules.map((moduleInfo) => {
        // local modules should be linked using the folder-names they should have,
        // no matter what folder-name they actually have, therefore don't use realFolderName here
        return systools.delete(path.join(cwd, 'node_modules', moduleInfo.folderName));
      }));
    });
}

function parseProcessArguments() {
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
    } else if (process.argv[i] === '--cleanup') {
      cleanup = true;
    } else if (process.argv[i] === '--dependency-check-only') {
      dependencyCheckOnly = true;
    }
  }
}

function cleanupDependencies() {
  return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((moduleInfos) => {
      return Promise.all(moduleInfos.modules.map((moduleInfo) => {
        // local modules should be linked using the folder-names they should have,
        // no matter what folder-name they actually have, therefore don't use realFolderName here
        return systools.delete(path.join(moduleInfo.fullModulePath, 'node_modules'));
      }));
    });
}

function run() {
  const startTime = Date.now();

  setupLogger();
  logger.level = 'info';
  parseProcessArguments();

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

  if (dependencyCheckOnly) {
    return moduletools.getAllModulesAndInstalledDependenciesDeep()
    .then((result) => {
      const localModules = result.modules;
      const requestedDependencies = findRequestedDependencies(localModules);
      printNonOptimalDependencyInfos(requestedDependencies);
    });
  }

  checkStartConditions()
    .then(() => {
      if (linkModules) {
        return deleteLinkedLocalModules();
      }
      return null;
    })
    .then(() => {
      if (cleanup) {
        return cleanupDependencies();
      }

      return null;
    })
    .then(() => {
      return installModuleDependencies();
    })
    .then((updatedModules) => {
      return runPostinstalls();
    })
    .then(() => {
      logIfInRoot(`\nminstall finished in ${systools.getRuntime(startTime)} :)\n\n`);
    })
    .catch(UncriticalError, (error) => {
      logIfInRoot(error.message);
    });
}

run();
