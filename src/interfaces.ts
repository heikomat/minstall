import {ModuleInfo} from './module_info';

export type ModulePath = string;
export type SemverRange = string;

export interface DependencyInfo {
  name: string;
  versionRange: SemverRange;
  identifier: string;
}

export interface DependencyRequestInfo extends DependencyInfo {
  requestedBy: Array<ModulePath>;
}

export interface ModulesAndDependenciesInfo {
  modules: Array<ModuleInfo>;
  installedDependencies: Array<ModuleInfo>;
}

export interface DependencyRequests {
  [dependencyName: string]: {
    [requestedVersionRange: string]: Array<ModulePath>;
  };
}

export interface DependencyTargetFolder {
  [targetFolderPath: string]: Array<DependencyRequestInfo>;
}
