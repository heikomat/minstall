

## Usage
- install with `npm install minstall --save`
- add it as postinstall-script in your package.json:
- `modules-folder` is optional, and defaults to `modules` if omitted
```JavaScript
"scripts": {
  "postinstall": "minstall <modules-folder>"
}
```

## Why do i need this? Because it ...
- auto-installs your local sub-modules on `npm install`
- minimizes the installed dependencies, because no dependency gets installed twice
- allows yout to require local modules without navigating. ~~`require('./modules/myModule')`~~ -> `require('myModule')`

## How does it do this? By...
- symlinking all sub-modules to the root-`node_modules`
- installing the dependencies of all local sub-modules into the root-`node_modules`
- except the ones that would cause conflicts, those end up in the associated module-`node_modules`

## In collaboration with
![5Minds IT-Solutions](img/5minds_logo.png "5Minds IT-Solutions")
#### [5minds.de](https://5minds.de)
#### [github.com/5minds](https://github.com/5minds)
