#!/usr/bin/env node
import * as minimatch from 'minimatch';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as semver from 'semver';
import {intersect} from 'semver-intersect';
import * as logger from 'winston';

const cwd: string = process.cwd();

import {ModuleInfo} from './module_info';
import {moduletools} from './moduletools';
import {systools} from './systools';
import {UncriticalError} from './uncritical_error';

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
let linkOnly = false;
let assumeLocalModulesSatisfyNonSemverDependencyVersions = false;
const noHoistList = [];

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

async function checkStartConditions() {
  logger.debug('checking start conditions');
  let results = await Promise.all([
    systools.verifyFolderName(cwd, 'node_modules'),
    getLocalPackageInfo(),
    systools.runCommand('npm --version', true),
  ]);

  let folderName = results[0];
  localPackage = results[1];
  npmVersion = results[2];

  if (semver.satisfies(npmVersion, '5.7.0')) {
    logger.error(`You're using npm 5.7.0. Do not use this version, it has a critical bug that is fixed in 5.7.1. See npm-issue #19883 for more info`);
    process.exit(1);
  }

  // npm 5 workaround until npm-issue #16853 is fixed replace the if-confition
  // and log when npm >= 5.7.1 is confirmed working without that workaround
  // if (semver.satisfies(npmVersion, '>=5.0.0 <5.7.0')) {
  if (semver.major(npmVersion) === 5) {
    // logger.info('npm >=5.0.0 <5.7.0 detected. forcing --cleanup');
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

  if (folderName === null) {
    logger.debug('project folder has no node_modules-folder');

    if (!installedAsDependency) {
      logger.debug('project is not in a node_modules folder');
      throw new UncriticalError('minstall started from outside the project-root. aborting.');
    }
  } else {
    logger.debug('project folder has node_modules-folder');
  }

  folderName = '.';
  if (moduletools.modulesFolder !== '.') {
    folderName = await systools.verifyFolderName(cwd, moduletools.modulesFolder);
  }

  if (folderName === null) {
    throw new UncriticalError(`${moduletools.modulesFolder} not found, thus minstall is done :)`);
  }

  if (installedAsDependency) {
    return null;
  }

  results = await Promise.all([
    systools.isSymlink(path.join(cwd, 'node_modules')),
    getLocalPackageInfo(),
  ]);

  if (installedAsDependency) {
    return;
  }

  if (isInProjectRoot) {
    isInProjectRoot = !results[0];
  }

  if (isInProjectRoot && !localPackage.dependencies.minstall) {
    throw new UncriticalError('minstall started from outside the project-root. aborting.');
  }
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
          intersection = intersect(version, requestedVersion);
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

          // we don't wan't that module to end up in multiple version-lists of that dependency
          break;
        }
      }

      if (!versionFound) {
        if (requestedDependencies[dependency][module.dependencies[dependency]] !== undefined) {
          // the requested version wasn't found, but the exact version is already in the requested dependencies
          // This means, that semver-intersect couldn't parse the version, which means it's not a semver-version
          requestedDependencies[dependency][module.dependencies[dependency]].push(module.fullModulePath);
        } else {
          requestedDependencies[dependency][module.dependencies[dependency]] = [
            module.fullModulePath,
          ];
        }
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

        const rangeIsValidAndSatisfied = semver.validRange(requestedDependencyVersionRange) && semver.satisfies(localModule.version, requestedDependencyVersionRange);
        const rangeIsInvalidAndAssumedToBeSatisfied = !semver.validRange(requestedDependencyVersionRange) && assumeLocalModulesSatisfyNonSemverDependencyVersions;
        const dependencyIsSatisfiedByLocalModule = rangeIsValidAndSatisfied || rangeIsInvalidAndAssumedToBeSatisfied;

        if (!dependencyIsSatisfiedByLocalModule) {
          continue;
        }

        const shortenedLocalLocation = `.${localModule.location.substr(cwd.length)}`;
        const shortenedRequesterLocations = result[requestedDependencyName][requestedDependencyVersionRange].map((locationOfRequestingModule) => {
          return `.${locationOfRequestingModule.substr(cwd.length)}`;
        });

        if (rangeIsInvalidAndAssumedToBeSatisfied) {

          logger.info(`Assuming that local module ${shortenedLocalLocation} satisfies ${requestedDependencyName}@${requestedDependencyVersionRange} requested by ${shortenedRequesterLocations.join(', ')}`);
        }

        for (const locationOfRequestingModule of result[requestedDependencyName][requestedDependencyVersionRange]) {
          // if the version matches the local module will satisfy the dependency, because even if it would get shadowed,
          // shadowed dependencies will get fixed with symlinks!
          const shortenedRequesterLocation = `.${locationOfRequestingModule.substr(cwd.length)}`;
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

function _dontHoistDependency(optimalDependencyTargetFolder, requestedDependency) {
  for (const installationTarget of requestedDependency.requestedBy) {

    if (!optimalDependencyTargetFolder[installationTarget]) {
      optimalDependencyTargetFolder[installationTarget] = [];
    }

    optimalDependencyTargetFolder[installationTarget].push(requestedDependency);
  }
}

function determineDependencyTargetFolder(requestedDependencyArray, alreadyInstalledDependencies) {

  const optimalDependencyTargetFolder = {};
  for (const requestedDependency of requestedDependencyArray) {

    const requestedVersionIsValidSemver = semver.validRange(requestedDependency.versionRange);
    if (requestedVersionIsValidSemver === null) {
      // if the requested version is NOT valid semver, we can't hoist the
      // dependency. This is the case for github urls. In that case we just
      // install the dependency to the folder it is requested in.
      const requestedByString = requestedDependency.requestedBy.map((requestedByPath) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n  ');

      logger.warn(`${requestedDependency.requestedBy.length} modules request ${requestedDependency.identifier}. This dependency won't get optimized (hoisted), because '${requestedDependency.versionRange}' is not a vaild semver-range. If ${requestedDependency.name} is one of your local modules, you can try the --trust-local-modules flag. These modules all get their own copy of that Dependency:\n  ${requestedByString}`);
      _dontHoistDependency(optimalDependencyTargetFolder, requestedDependency);
      continue;
    }

    const matchingNoHoistEntry = noHoistList.find((noHoistEntry) => {
      // if the name of the requrested dependency doesn't match the noHoistEntry, then this noHoistEntry should
      // not affect the hoisting of that dependency
      if (!minimatch(requestedDependency.name, noHoistEntry.name)) {
        return false;
      }

      if (noHoistEntry.versionRange === undefined) {
        return true;
      }

      if (requestedDependency.versionRange === noHoistEntry.versionRange) {
        return true;
      }

      try {
        const intersection = intersect(requestedDependency.versionRange, noHoistEntry.versionRange);
      } catch (error) {
        // the versions didn't intersect
        return false;
      }

      // the versions do intersect
      return true;
    });

    if (matchingNoHoistEntry !== undefined) {
      // The requested dependency is flagged as "should not get hoisted", so we don't hoist it.
      const requestedByString = requestedDependency.requestedBy.map((requestedByPath) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n  ');

      logger.info(`${requestedDependency.identifier} instersects with no-hoist-flag ${matchingNoHoistEntry.identifier}, so it won't get hoisted for the following modules:\n  ${requestedByString}`);
      _dontHoistDependency(optimalDependencyTargetFolder, requestedDependency);
    }

    // If we work with valid semver, it doesn't matter where the dependency
    // gets Installed, even if mutliple modules need it, because in that case
    // it will be symlinked from wherever it is installed. Because of this we
    // just work with the path of the first module that requests this dependency
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

      return `
|   version ${requestedVersion.versionRange} satisfies ${requestedVersion.requestedBy.length} local modules:
|     ${requestedByString}`;
    }).join('\n| ');

    logIfInRoot(`|
| ${mostRequested.requestedBy.length} local modules are satisfied with version ${mostRequested.versionRange} of ${mostRequested.name}, but some aren't:${requestedByOtherPackagesString}`);
  }

  if (initialMessagePrinted) {
    logIfInRoot('└---------------------------------------');
    logIfInRoot(' ');
  } else {
    logIfInRoot('No suboptimal dependencies found');
  }
}

function printNonOptimalLocalModuleUsage(localModules, requestedDependencies) {
  let requestedDependencyArray = dependenciesToArray(requestedDependencies);
  requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);
  let initialMessagePrinted = false;

  for (const requestedDependencyName in requestedDependencies) {
    const localVersionOfDependency = localModules.find((localModule) => {
      return localModule.name === requestedDependencyName;
    });

    // We don't need to warn about suboptimal local module usage, if the dependency
    // is not available as local module
    if (!localVersionOfDependency) {
      continue;
    }

    // find the most requested version
    const requestedWithIncompatibleVersion = requestedDependencyArray.filter((dependency) => {
      // if the name doesn't match then this is not a dependency we're looking for
      if (dependency.name !== localVersionOfDependency.name) {
        return false;
      }

      // if the local version satisfies the requested range, then this dependency is not incompatible
      if (semver.satisfies(localVersionOfDependency.version, dependency.versionRange)) {
        return false;
      }

      // At this point, the only at way for the dependency to be not incompatible,
      // is if the requested versionrange is not a valid semver range, and the
      // flag to assume that these are fulfilled is set
      if (assumeLocalModulesSatisfyNonSemverDependencyVersions === true && !semver.validRange(dependency.versionRange)) {
        return false;
      }

      // at this point we either have a valid but non-satisfied semver-range, or
      // an invalid semver-range while not assuming that local modules satisfy
      // these invalid ranges
      return true;
    });

    // if no conflicting version is requested, continue
    if (requestedWithIncompatibleVersion.length === 0) {
      continue;
    }

    if (!initialMessagePrinted) {
      logger.warn('THE FOLLOWING WILL BREAK YOUR INSTALLATION IF YOU RELY ON SINGLETONS!');
      logIfInRoot('┌-----------------------------------------');
      logIfInRoot('| NON-OPTIMAL LOCAL-MODULE-USAGE DETECTED!');
      initialMessagePrinted = true;
    }

    const requestedByOtherPackagesString = requestedWithIncompatibleVersion.map((requestedVersion) => {
      const requestedByString = requestedVersion.requestedBy.map((requestedByPath) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n|     ');

      return `
|   version ${requestedVersion.versionRange} is requested by ${requestedVersion.requestedBy.length} local modules:
|     ${requestedByString}`;
    }).join('\n| ');

    logIfInRoot(`|
| you have version ${localVersionOfDependency.version} of ${localVersionOfDependency.name} localy, but some local modules request a different version:${requestedByOtherPackagesString}`);
  }

  if (initialMessagePrinted) {
    logIfInRoot('└-----------------------------------------');
    logIfInRoot(' ');
  } else {
    logIfInRoot('No suboptimal local-module-usage found');
  }
}

async function removeContradictingInstalledDependencies() {
  // remove all packages that contradict a modules package.json.
  // for example: module A requires B in version 2.0.0, and in
  // A/node_modules is a package B, but it is in version 1.0.0.
  // In that case, delete A/node_modules/B
  const result = await moduletools.getAllModulesAndInstalledDependenciesDeep();

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
}

async function findOptimalDependencyTargetFolder() {
  // create a list of places where dependencies should go. Remember to not install
  // dependencies that appear in the modules list, except when they won't be linked.

  const result = await moduletools.getAllModulesAndInstalledDependenciesDeep();

  const localModules = result.modules;
  const alreadyInstalledDependencies = result.installedDependencies;

  // Find all dependencies of all modules in the requested versions
  let requestedDependencies = findRequestedDependencies(localModules);

  printNonOptimalDependencyInfos(requestedDependencies);
  printNonOptimalLocalModuleUsage(localModules, requestedDependencies);

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
}

async function fixMissingDependenciesWithSymlinks() {

  const result = await moduletools.getAllModulesAndInstalledDependenciesDeep();

  const localModules = result.modules;
  const installedDependencies = result.installedDependencies;
  const symlinkPromises = [];

  for (const module of localModules) {
    for (const dependency in module.dependencies) {
      const requestedDependencyVersionRange = module.dependencies[dependency];
      // check if the dependency is already installed localy
      let dependencyAlreadyInstalled = false;
      let fittingInstalledModule = null;
      for (const installedModule of installedDependencies) {
        if (installedModule.name !== dependency) {
          continue;
        }

        if (installedModule.fullModulePath === path.join(module.fullModulePath, 'node_modules', installedModule.folderName)) {
          fittingInstalledModule = installedModule;
          dependencyAlreadyInstalled = true;
          break;
        } else if (semver.satisfies(installedModule.version, requestedDependencyVersionRange)) {
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

          const rangeIsValidAndSatisfied = semver.validRange(requestedDependencyVersionRange) && semver.satisfies(localModule.version, requestedDependencyVersionRange);
          const rangeIsInvalidAndAssumedToBeSatisfied = !semver.validRange(requestedDependencyVersionRange) && assumeLocalModulesSatisfyNonSemverDependencyVersions;
          const dependencyIsSatisfiedByLocalModule = rangeIsValidAndSatisfied || rangeIsInvalidAndAssumedToBeSatisfied;

          if (localModule.name !== dependency || !dependencyIsSatisfiedByLocalModule) {
            continue;
          }

          fittingInstalledModule = localModule;
          break;
        }
      }

      if (!dependencyAlreadyInstalled) {
        if (!fittingInstalledModule) {
          logger.error(`NO INSTALLATION FOUND FOR DEPENDENCY ${dependency} ON ${module.fullModulePath}. This shouldn't happen!`);
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
}

function printInstallationStatus(startedInstallationCount, finishedInstallations) {
  readline.clearLine(process.stdout, 0);
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

async function installModuleDependencies() {

  await removeContradictingInstalledDependencies();
  const targets = await findOptimalDependencyTargetFolder();

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
  printInstallationStatus(Object.keys(targets).length, []);

  await Promise.all(installPromises);

  process.stdout.write('\n');

  // Now we're in a state where every dependency required by any local module
  // is installed at least somewhere. To make the modules find their dependencies
  // we now symlink them to the modules
  return fixMissingDependenciesWithSymlinks();

  // TODO: delete all unnecessary double-installs (when a and b both had a sub-dependency c that thus got installed twice)
  // this has low priority, as this is a rare edge-case with no real negative side-effects except a tiny bit bigger folder-size
}

async function runPostinstalls() {
  const result = await moduletools.getAllModulesAndInstalledDependenciesDeep();

  const localModules = result.modules;
  const postinstallPromises = [];

  for (const module of localModules) {
    if (module.fullModulePath === cwd) {
      logger.debug('skipping the postinstall of the parent-module');
      continue;
    }

    if (!module.postinstallCommand) {
      logger.debug(`skipping the postinstall of ${module.name}. it has no postinstall script.`);
      continue;
    }

    logger.debug(`running postinstall of ${module.name}`);
    postinstallPromises.push(systools.runCommand(`cd ${module.fullModulePath}${commandConcatSymbol} ${module.postinstallCommand}`));
  }

  return Promise.all(postinstallPromises);
}

async function deleteLinkedLocalModules() {
  const moduleInfos = await moduletools.getAllModulesAndInstalledDependenciesDeep();

  return Promise.all(moduleInfos.modules.map((moduleInfo) => {
    // local modules should be linked using the folder-names they should have,
    // no matter what folder-name they actually have, therefore don't use realFolderName here
    return systools.delete(path.join(cwd, 'node_modules', moduleInfo.folderName));
  }));
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
    } else if (process.argv[i] === '--assume-local-modules-satisfy-non-semver-dependency-versions' || process.argv[i] === '--trust-local-modules') {
      assumeLocalModulesSatisfyNonSemverDependencyVersions = true;
    } else if (process.argv[i] === '--link-only') {
      linkOnly = true;
    } else if (process.argv[i] === '--no-hoist') {
      const noHoistEntry = process.argv[i + 1].split('@');
      noHoistList.push({
        name: noHoistEntry[0],
        versionRange: noHoistEntry[1],
        identifier: `${noHoistEntry[0]}@${noHoistEntry[1]}`,
      });

      i++;
    }
  }
}

async function cleanupDependencies() {
  const moduleInfos = await moduletools.getAllModulesAndInstalledDependenciesDeep();

  return Promise.all(moduleInfos.modules.map((moduleInfo) => {
    // local modules should be linked using the folder-names they should have,
    // no matter what folder-name they actually have, therefore don't use realFolderName here
    return systools.delete(path.join(moduleInfo.fullModulePath, 'node_modules'));
  }));
}

async function run() {
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
    const result = await moduletools.getAllModulesAndInstalledDependenciesDeep();
    const localModules = result.modules;
    const requestedDependencies = findRequestedDependencies(localModules);
    printNonOptimalDependencyInfos(requestedDependencies);
    printNonOptimalLocalModuleUsage(localModules, requestedDependencies);

    return;
  }

  if (linkOnly) {
    return fixMissingDependenciesWithSymlinks();
  }

  try {
    await checkStartConditions();
    if (linkModules) {
      await deleteLinkedLocalModules();
    }

    if (cleanup) {
      await cleanupDependencies();
    }

    const updatedModules = await installModuleDependencies();
    await runPostinstalls();
    logIfInRoot(`\nminstall finished in ${systools.getRuntime(startTime)} :)\n\n`);
  } catch (error) {
    if (error.constructor !== undefined && error.constructor.name === 'UncriticalError') {
      logIfInRoot(error.message);
    } else {
      throw error;
    }
  }
}

run();
