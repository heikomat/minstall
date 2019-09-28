
import * as minimatch from 'minimatch';
import * as path from 'path';
import * as semver from 'semver';
import {intersect} from 'semver-intersect';
import * as logger from 'winston';

import {
  DependencyInfo,
  DependencyRequestInfo,
  DependencyRequests,
  DependencyTargetFolder,
  ModulesAndDependenciesInfo,
  SemverRange,
} from './interfaces';
import {ModuleInfo} from './module_info';

const cwd: string = process.cwd();

function _dontHoistDependency(optimalDependencyTargetFolder: DependencyTargetFolder, requestedDependency: DependencyRequestInfo): void {
  for (const installationTarget of requestedDependency.requestedBy) {

    if (!optimalDependencyTargetFolder[installationTarget]) {
      optimalDependencyTargetFolder[installationTarget] = [];
    }

    optimalDependencyTargetFolder[installationTarget].push(requestedDependency);
  }
}

function _dontHoistInvalidSemverRequests(requestedDependency: DependencyRequestInfo, optimalDependencyTargetFolder: DependencyTargetFolder): boolean {
  const requestedVersionIsValidSemver: string = semver.validRange(requestedDependency.versionRange);
  if (requestedVersionIsValidSemver !== null) {
    return false;
  }

  // if the requested version is NOT valid semver, we can't hoist the
  // dependency. This is the case for github urls. In that case we just
  // install the dependency to the folder it is requested in.
  const requestedByString: string = requestedDependency.requestedBy.map((requestedByPath: string) => {
    return `.${requestedByPath.substr(cwd.length)}`;
  })
    .join('\n  ');

  // tslint:disable-next-line:max-line-length
  logger.warn(`${requestedDependency.requestedBy.length} modules request ${requestedDependency.identifier}. This dependency won't get optimized (hoisted), because '${requestedDependency.versionRange}' is not a vaild semver-range. If ${requestedDependency.name} is one of your local modules, you can try the --trust-local-modules flag. These modules all get their own copy of that Dependency:\n  ${requestedByString}`);
  _dontHoistDependency(optimalDependencyTargetFolder, requestedDependency);

  return true;
}

function _findMatchingNoHoistEntry(requestedDependency: DependencyRequestInfo, noHoistList: Array<DependencyInfo>): DependencyInfo {
  return noHoistList.find((noHoistEntry: DependencyInfo) => {
    // if the name of the requrested dependency doesn't match the noHoistEntry, then this noHoistEntry should
    // not affect the hoisting of that dependency
    if (!minimatch(requestedDependency.name, noHoistEntry.name)) {
      return false;
    }

    // if no versionRange was set, then no version of that dependency will get hoisted
    if (noHoistEntry.versionRange === undefined) {
      return true;
    }

    if (requestedDependency.versionRange === noHoistEntry.versionRange) {
      return true;
    }

    try {
      const intersection: SemverRange = intersect(requestedDependency.versionRange, noHoistEntry.versionRange);
    } catch (error) {
      // the versions didn't intersect
      return false;
    }

    // the versions do intersect
    return true;
  });
}

function _dontHoistExcludedDependencies(
  requestedDependency: DependencyRequestInfo,
  optimalDependencyTargetFolder: DependencyTargetFolder,
  noHoistList: Array<DependencyInfo>,
): boolean {
  const matchingNoHoistEntry: DependencyInfo = _findMatchingNoHoistEntry(requestedDependency, noHoistList);
  if (matchingNoHoistEntry === undefined) {
    return false;
  }

  // The requested dependency is flagged as "should not get hoisted", so we don't hoist it.
  const requestedByString: string = requestedDependency.requestedBy.map((requestedByPath: string) => {
    return `.${requestedByPath.substr(cwd.length)}`;
  })
    .join('\n  ');

  // tslint:disable-next-line:max-line-length
  logger.info(`${requestedDependency.identifier} instersects with no-hoist-flag ${matchingNoHoistEntry.identifier}, so it won't get hoisted for the following modules:\n  ${requestedByString}`);
  _dontHoistDependency(optimalDependencyTargetFolder, requestedDependency);

  return true;
}

function _handleIfDependencyIsAlreadyOnInstallList(
  currentPath: string,
  requestedDependency: DependencyRequestInfo,
  optimalDependencyTargetFolder: DependencyTargetFolder,
): boolean {
  for (const modulePath in optimalDependencyTargetFolder) {
    const modulesToBeInstalled: Array<DependencyRequestInfo> = optimalDependencyTargetFolder[modulePath];
    const matchingModule: DependencyRequestInfo = modulesToBeInstalled.find((moduleToBeInstalled: DependencyRequestInfo) => {
      return moduleToBeInstalled.identifier === requestedDependency.identifier;
    });

    if (matchingModule) {
      // tslint:disable-next-line:max-line-length
      logger.debug(`no need to install ${requestedDependency.identifier} to ${currentPath}. a matching version will already be installed to ${modulePath}`);

      return true;
    }
  }

  return false;
}

function _handleIfConflictingDependencyIsAlreadyInstalled(
  currentPath: string,
  requestedDependency: DependencyRequestInfo,
  alreadyInstalledDependencies: Array<ModuleInfo>,
): boolean {

  for (const installedDependency of alreadyInstalledDependencies) {
    if (installedDependency.name === requestedDependency.name
        && installedDependency.location === path.join(currentPath, 'node_modules')) {
      // tslint:disable-next-line:max-line-length
      logger.debug(`${requestedDependency.identifier} can't be installed to ${currentPath}. it conflicts with the already installed ${installedDependency.name}@"${installedDependency.version}"`);

      return true;
    }
  }

  return false;
}

function _handleIfConflictingDependencyWillBeInstalled(
  currentPath: string,
  requestedDependency: DependencyRequestInfo,
  optimalDependencyTargetFolder: DependencyTargetFolder,
): boolean {

  if (!optimalDependencyTargetFolder[currentPath]) {
    return false;
  }

  const conflictingDependency: DependencyRequestInfo = optimalDependencyTargetFolder[currentPath]
    .find((toBeInstalledDependency: DependencyRequestInfo) => {
      return toBeInstalledDependency.name === requestedDependency.name
              && toBeInstalledDependency.versionRange !== requestedDependency.versionRange;
    });

  if (conflictingDependency) {
    // tslint:disable-next-line:max-line-length
    logger.debug(`${requestedDependency.identifier} can't be installed to ${currentPath}. it'd conflict with the to be installed ${conflictingDependency.identifier}`);

    return true;
  }

  return false;
}

export function determineDependencyTargetFolder(
  requestedDependencyArray: Array<DependencyRequestInfo>,
  alreadyInstalledDependencies: Array<ModuleInfo>,
  noHoistList: Array<DependencyInfo>,
): DependencyTargetFolder {

  const optimalDependencyTargetFolder: DependencyTargetFolder = {};
  for (const requestedDependency of requestedDependencyArray) {

    const dependencyWontGetHoisted: boolean = _dontHoistInvalidSemverRequests(requestedDependency, optimalDependencyTargetFolder)
                                           || _dontHoistExcludedDependencies(requestedDependency, optimalDependencyTargetFolder, noHoistList);
    if (dependencyWontGetHoisted) {
      continue;
    }

    // If we work with valid semver, it doesn't matter where the dependency
    // gets Installed, even if mutliple modules need it, because in that case
    // it will be symlinked from wherever it is installed. Because of this we
    // just work with the path of the first module that requests this dependency
    const possiblePathElements: Array<string> = requestedDependency.requestedBy[0]
      .substr(cwd.length)
      .split(path.sep)
      .filter((pathElement: string) => {
        return pathElement.length > 0;
      });

    // because we check the current path first, and then add the path element, the last element won't be checked.
    // because of that we just add another pathElement that will be ignored, but will make the last real
    // pathElement not be ignored
    possiblePathElements.push('');
    let currentPath: string = cwd;

    for (const possiblePathElement of possiblePathElements) {
      // is this Dependency already on the list of things to install?
      const installModuleHere = !(
        _handleIfDependencyIsAlreadyOnInstallList(currentPath, requestedDependency, optimalDependencyTargetFolder)
        || _handleIfConflictingDependencyIsAlreadyInstalled(currentPath, requestedDependency, alreadyInstalledDependencies)
        || _handleIfConflictingDependencyWillBeInstalled(currentPath, requestedDependency, optimalDependencyTargetFolder)
      );

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
