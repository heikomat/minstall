'use strict';

class InstalledVersionMismatchError extends Error {
  constructor(message, moduleName, packageName, checkVersion, targetRange) {
    super (`${message} installed package ${packageName}@${checkVersion} doesn't fit the dependency ${packageName}@${targetRange} from ${moduleName}`);
    this._moduleName = moduleName;
    this._packageName = packageName;
    this._checkVersion = checkVersion;
    this._targetRange = targetRange;
  }

  get moduleName() {
    return this._moduleName;
  }

  get packageName() {
    return this._packageName;
  }

  get checkVersion() {
    return this._checkVersion;
  }

  get targetRange() {
    return this._targetRange;
  }
}

module.exports = InstalledVersionMismatchError;
