Minstall is a local module installer, intended to be used as postinstall-script.

## Example
Let's say you have the following modular app, and run `npm install` on it:
```
my-modular-app
├── modules
│   ├── database
│   │   ├── index.js
│   │   └── package.json [requires mongoose and lodash]
│   └── tasks
│       ├── index.js
│       └── package.json [requires lodash]
├── index.js
└── package.json [requires express, uses database and tasks]
```

#### The problems
- Your local modules (`database` and `tasks`) wouldn't work, because their dependencies are missing.
- To require your modules, you would need to either npm-link them, or use a `./modules/`-prefix

#### The solution
Minstall installs the necessary dependencies to the root-`node_modules`, and symlinks the modules there.  
After running `npm install` with minstall as postinstall, the structure looks like this:
```
my-modular-app
├── modules
│   ├── database
│   └── tasks
├── node_modules
│   ├── express
│   ├── lodash
│   ├── minstall
│   ├── mongoose
│   ├── database -> ../modules/database
│   └── tasks -> ../modules/tasks
├── index.js
└── package.json
```
- All modules work, because their dependencies are present
  - conflicting dependencies end up in the associated modules, not in the root
- Modules can be required directly, because they are symlinked
  - ~~`require('./modules/database')`~~ -> `require('database')`
- The installation is faster and smaller, because dependencies are only installed once
  - dependencies that are already installed, are not re-downloaded


## Usage
- install with `npm install minstall --save`
- add it as postinstall-script in your package.json:
- `modules-folder` is optional, and defaults to `modules` if omitted
```JavaScript
"scripts": {
  "postinstall": "minstall <modules-folder>"
}
```

## In collaboration with
![5Minds IT-Solutions](img/5minds_logo.png "5Minds IT-Solutions")
#### [5minds.de](https://5minds.de)
#### [github.com/5minds](https://github.com/5minds)
