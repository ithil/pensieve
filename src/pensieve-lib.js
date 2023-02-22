const fs = require('fs')
const path = require('path')
const exec = require('child_process').exec
const crypto = require('crypto')
const { EventEmitter } = require("events")
const MarkdownIt = require('markdown-it')
const moment = require('moment')
require('moment/locale/de.js')
const unorm = require('unorm')
const Fuse = require('fuse.js')
const chokidar = require('chokidar')
const mime = require('mime-types')
const getAppDataPath = require('appdata-path')
const editJsonFile = require("edit-json-file")
const git = require('isomorphic-git')
const http = require('isomorphic-git/http/node')

const pVersion = '0.1'
const pensieveConfigPath = getAppDataPath('pensieve')

var md = new MarkdownIt({linkify: true, html: true})


var utils = {
  searchCollectionJson(startPath) {
    startPath = startPath || process.cwd()
    currentPath = startPath
    var listing
    while (currentPath != '/') {
      try {
        listing = fs.readdirSync(currentPath)
        if (listing.includes('.collection.json')) {
          return path.join(currentPath, '.collection.json')
        }
        else {
          currentPath = path.normalize(path.join(currentPath, '..'))
        }
      }
      catch (e) {
        if (e.code == 'ENOENT') {
          currentPath = path.normalize(path.join(currentPath, '..'))
          continue
        }
        else {
          throw e
        }
      }
    }
    var error = Error(`Couldn't find .collection.json in ${startPath} or parent directories.`)
    error.name = 'noCollectionJson'
    throw error
  },
  objectMap(obj, fn) {
    return Object.fromEntries(
      Object.entries(obj).map(
        ([k, v], i) => [k, fn(v, k, i)]
      )
    )
  },
  createPwHash(pw) {
    var md5sum = crypto.createHash('md5')
    return md5sum.update(pw).digest('hex')
  },
  createNewCollectionJson() {
    var collectionJson = {
      "pVersion": pVersion,
      "name": "My Note Collection",
      "creationDate": new Date(),
      "useGit": true,
      "paths": {
        "stacks": "./Stacks",
        "archive": "./Archived",
        "cache": "./.cache",
      },
      "specialStacks": {
        "inbox": "Inbox",
        "anything": "anything",
        "appendix": "appendix",
      },
      "tags": [],
    }
    return collectionJson
  },
  tokenizeMarkdown(s) {
    tokens = md.parse(s, {})
    return tokens.filter(t => t.type == 'inline').map(t =>  Object({
      "content": t.content,
      "line": t.map ? t.map[0]+1 : undefined
    }))
  }
}

function newCollection(dir, options) {
  try {
    var collectionJsonPath = utils.searchCollectionJson(dir)
  }
  catch (e) {
    if (e.name == 'noCollectionJson') {
      var collectionJson = {...utils.createNewCollectionJson(), ...options}
      !fs.existsSync(dir) && fs.mkdirSync(dir, { recursive: true })
      if (!options.proxy) {
        for (var k in collectionJson.paths) {
          var p = collectionJson.paths[k]
          if (!path.isAbsolute(p)) {
            p = path.resolve(dir, p)
          }
          !fs.existsSync(p) && fs.mkdirSync(p, { recursive: true })
        }
        fs.writeFileSync(path.join(dir, '.collection.json'), JSON.stringify(collectionJson, null, ' '), 'utf8')
        if (collectionJson.useGit) {
          let repo = { fs, dir }
          git.init(repo)
          .then(() => {
            return git.statusMatrix(repo)
          })
          .then((status) => {
            Promise.all(
              status.map(([filepath, , worktreeStatus]) => {
                worktreeStatus ? git.add({ ...repo, filepath }) : git.remove({ ...repo, filepath })
              })
            )
          })
          .then(() => {
            git.commit({
              ...repo,
              author: {name: 'Anonymous', email: 'anon@gmail.com'},
              message: 'Created Note Collection'}
            )
          })
        }
        return new NoteCollection(dir)
      }
      else {
        if (options.encrypted) {
          var password = options.password
          var myPaths = options.paths
          collectionJson.passwordHash = utils.createPwHash(password)
          delete collectionJson.password
          delete collectionJson.paths
          var plist = require('plist')
          fs.writeFileSync(path.join(dir, '.collection.json'), JSON.stringify(collectionJson, null, ' '), 'utf8')
          exec(
            `printf '%s\\0' ${password} | hdiutil create -volname "${collectionJson.name}" -size 100m -type SPARSE -fs HFS+ "${path.join(dir, 'collection.sparseimage')}" -stdinpass -encryption AES-128 -plist`,
            (e, stdout, stderr) => {
              // console.log(`1. ${e}, ${stderr}, ${stdout}`)
              exec(`printf '%s\\0' ${password} | hdiutil attach "${path.join(dir, 'collection.sparseimage')}" -stdinpass -plist`,
                (e, stdout, stderr) => {
                  // console.log(`2. ${e}, ${stderr}, ${stdout}`)
                  var ans = plist.parse(stdout)
                  var mountPoint = ans['system-entities'].find(i => i.hasOwnProperty('mount-point'))['mount-point']
                  fs.copyFile(
                    path.resolve(__dirname, 'assets/PensieveRemovable.icns'),
                    path.resolve(mountPoint, '.VolumeIcon.icns'),
                    (err) => { if(err) throw err }
                  )
                  newCollection(mountPoint, {
                    ...collectionJson,
                    proxy: false,
                    paths: myPaths,
                  })
                }
              )
            }
          )
        }
      }
    }
  }
  finally {
    if (collectionJsonPath) {
      var err = new Error(`Can't use ${dir} as path, since there already is a .collection.json at ${collectionJsonPath}`)
      err.name = 'existantCollectionJson'
      throw err
    }
  }
}

class NoteCollection{
  constructor(dir, opts={}) {
    try {
      this.collectionJsonPath = utils.searchCollectionJson(dir)
      this.collectionJson = JSON.parse(fs.readFileSync(this.collectionJsonPath))
      this.name = this.collectionJson.name || 'Unnamed Note Collection'
      this.path = path.dirname(this.collectionJsonPath)
      this.paths = utils.objectMap(this.collectionJson.paths, p => path.resolve(this.path, p))
      this.stacks = new Stacks(this)
      this._stackStyleProps = {}
      var $this = this
      this.registers = (function() {
        let registersJsonPath = path.join($this.path, '.registers.json')
        if (fs.existsSync(registersJsonPath)) {
          let registersJson = JSON.parse(fs.readFileSync(registersJsonPath))
          return registersJson.registers || []
        }
        else {
          return []
        }
      })()
      if (this.collectionJson.useGit) {
        this.repo = { fs, dir: this.path }
      }
      this.emptyPorts()
      this.events = new EventEmitter()
    }
    catch (e) {
      throw e
    }
  }
  static open(dir, opts={}, callback) {
    try {
      var collectionJsonPath = utils.searchCollectionJson(dir)
      var collectionJson = JSON.parse(fs.readFileSync(collectionJsonPath))
      if (collectionJson.proxy && collectionJson.encrypted) {
        if (opts.password) {
          if (collectionJson.passwordHash == utils.createPwHash(opts.password)) {
            var plist = require('plist')
            // Check here via `hdiutil info` if volume already attached
            exec(`printf '%s\\0' ${opts.password} | hdiutil attach "${path.join(dir, 'collection.sparseimage')}" -stdinpass -plist`,
            (e, stdout, stderr) => {
              var ans = plist.parse(stdout)
              var mountPoint = ans['system-entities'].find(i => i.hasOwnProperty('mount-point'))['mount-point']
              callback({
                status: 'openNoteCollection',
                collection: new NoteCollection(mountPoint)
              })
            }
          )
        }
        else {
          callback({
            status: 'passwordIncorrect'
          })
        }
      }
      else {
        callback({
          status: 'passwordRequired'
        })
      }
    }
    else {
      callback({
        status: 'openNoteCollection',
        collection: new NoteCollection(dir)
      })
    }
  }
  catch (e) {
    throw e
  }
}
  close() {
    // Detach
  }
  _rmFileSync(filepath) {
    fs.unlinkSync(filepath)
  }
  _rmFileAsync(filepath, callback) {
    fs.unlink(filepath, callback)
  }
  emptyPorts() {
    var myPorts = ports.filter(p => p.collectionName == this.name)
    for (let p of myPorts) {
      p.emptyPort(this)
    }
  }
  watch() {
    var collection = this
    this.stacksWatcher = chokidar.watch(this.paths.stacks, {
      followSymlinks: false,
      ignoreInitial: true,
      ignored: '*.swp',
      // awaitWriteFinish: true,
    })
    this.stacksWatcher.on('all', (event, thisPath) => {
      if (!path.isAbsolute(thisPath)) {
        thisPath = path.join(this.paths.stacks, thisPath)
      }
      if (event == 'add') {
        var fleetingNote = new FleetingNote(thisPath, this)
        this.events.emit('stacksItemAdd', fleetingNote, collection.stacksWatcher)
      }
      else if (event == 'change') {
        var fleetingNote = new FleetingNote(thisPath, this)
        this.events.emit('stacksItemChange', fleetingNote, collection.stacksWatcher)
      }
      else if (event == 'unlink') {
        this.events.emit('stacksItemDelete', thisPath, collection.stacksWatcher)
      }
    })
  }
  unwatch() {
    this.stacksWatcher.close()
  }
  commit() {
    var repo = this.repo
    var commitMessage = ''
    return git.statusMatrix(repo)
    .then((status) => {
      Promise.all(
        status.map(([filepath, , worktreeStatus]) => {
          worktreeStatus ? git.add({ ...repo, filepath }) : git.remove({ ...repo, filepath })
        })
      )
    })
    .then(() => {
      return git.statusMatrix(repo)
    })
    .then((status) => {
      let FILE = 0, HEAD = 1, WORKDIR = 2, STAGE = 3
      for (let row of status) {
        if (!row[HEAD] && row[WORKDIR] == 2 && row[STAGE] == 2) {
          commitMessage = commitMessage + `Add ${row[FILE]}\n`
        }
        else if (row[HEAD] && row[WORKDIR] == 2 && row[STAGE] == 2) {
          commitMessage = commitMessage + `Change ${row[FILE]}\n`
        }
        else if (row[HEAD] && !row[WORKDIR] && !row[STAGE]) {
          commitMessage = commitMessage + `Delete ${row[FILE]}\n`
        }
      }
    })
    .then(() => {
      git.commit({
        ...repo,
        author: {name: 'Anonymous', email: 'anon@gmail.com'},
        message: commitMessage}
      )
    })
  }
  getFleetingNoteByName(name) {
    var $this = this
    var walk = function(thisPath) {
      var listing = fs.readdirSync(thisPath, {withFileTypes: true})
      for (let i of listing) {
        if (i.isFile() && new RegExp(`^${name}\\.`).test(i.name)) {
          return new FleetingNote(path.join(thisPath, i.name), $this)
        }
        else if (i.isDirectory()) {
          let dirWalk = walk(path.join(thisPath, i.name))
          if (dirWalk) {
            return dirWalk
          }
        }
      }
    }
    var stacksWalk = walk($this.paths.stacks)
    if (stacksWalk) {
      return stacksWalk
    }
  }
  getFleetingNoteByPath(fnPath) {
    if (!path.isAbsolute(fnPath)) {
      fnPath = path.join(this.path, fnPath)
    }
    if (fs.existsSync(fnPath)) {
      return new FleetingNote(fnPath, this)
    }
  }
          }
        }
      }
  }
      }
          }
        }
      }
      }
  }
    }
  getStackStyleProps(stackRelativePath) {
    if (this._stackStyleProps && this._stackStyleProps[stackRelativePath]) {
      return this._stackStyleProps[stackRelativePath]
    }
    else {
      let stack = this.stacks.getStackByPath(stackRelativePath)
      let metadata = stack.metadata
      let style = metadata.get('style') || {}
      this._stackStyleProps[stackRelativePath] = style
      return this._stackStyleProps[stackRelativePath]
    }
  }
  saveCollectionJson() {
    fs.writeFileSync(this.collectionJsonPath, JSON.stringify(this.collectionJson, null, ' '), 'utf8')
  }
}

class Stacks{
  constructor(collection) {
    this.collection = collection
    this.path = collection.paths.stacks
  }
  getStacks(stacksOnly) {
    var collection = this.collection
    var getList = function(givenPath) {
      var listing = fs.readdirSync(givenPath, {withFileTypes: true})
      listing = listing.filter(f => /^[^\.]/.test(f.name))
      var list = []
      for (let i of listing) {
        if (i.isFile() && !stacksOnly) {
          list.push(new FleetingNote(path.join(givenPath, i.name), collection))
        }
        else if (i.isDirectory()) {
          list.push(new Stack(collection, path.join(givenPath, i.name)))
        }
      }
      return list
    }
    return getList(this.path)
  }
  getListOfStacks() {
    var collection = this.collection
    var getList = function(givenPath, list) {
      var list = list || []
      var listing = fs.readdirSync(givenPath, {withFileTypes: true})
      listing = listing.filter(f => /^[^\.]/.test(f.name))
      for (let i of listing) {
        if (i.isDirectory()) {
          var stackPath = path.join(givenPath, i.name)
          list.push(new Stack(collection, stackPath))
          for (let q of getList(stackPath)) {
            list.push(q)
          }
        }
      }
      return list
    }
    return getList(this.path)
  }
  getStackByPath(stackPath) {
    var fullStackPath = path.join(this.collection.paths.stacks, stackPath)
    if (fs.existsSync(fullStackPath)) {
      return new Stack(this.collection, fullStackPath)
    }
    else {
      return false
    }
  }
  getSpecialStack(role) {
    var stackPath = this.collection.collectionJson?.specialStacks[role]
    if (stackPath) {
      return this.getStackByPath(stackPath)
    }
    else {
      return false
    }
  }
}

class Stack{
  constructor(collection, stackPath, parent) {
    this.collection = collection
    this.path = stackPath
    this.relativePath = path.relative(collection.paths.stacks, this.path)
    this.parent = parent
    this.name = path.basename(stackPath)
    this.isInbox = (this.collection.collectionJson.specialStacks['inbox'] == this.relativePath)
    this.isStack = true
    this.metadata = editJsonFile(`${this.path}/.stack.json`)
  }
  getContent() {
    var collection = this.collection
    var getList = function(givenPath) {
      var listing = fs.readdirSync(givenPath, {withFileTypes: true})
      listing = listing.filter(f => /^[^\.]/.test(f.name))
      var list = []
      for (let i of listing) {
        if (i.isFile()) {
          list.push(new FleetingNote(path.join(givenPath, i.name), collection))
        }
        else if (i.isDirectory()) {
          list.push(new Stack(collection, path.join(givenPath, i.name), this))
        }
      }
      return list
    }
    return getList(this.path)
  }
  getCountOfNotes() {
    var listing = fs.readdirSync(this.path, {withFileTypes: true})
    listing = listing.filter(f => /^[^\.]/.test(f.name))
    return listing.filter(f => f.isFile()).length
  }
  sendText(text, filename) {
    filename = filename || `${moment().format('YYYY-MM-DD HH,mm,ss')}.md`
    var filepath = path.join(this.path, filename)
    fs.writeFileSync(filepath, text, 'utf8')
    return filepath
  }
  sendFile(filepath, cwd='') {
    var srcFilepath = path.resolve(cwd, filepath)
    var destFilepath = path.join(this.path, path.basename(srcFilepath))
    try {
      fs.copyFileSync(srcFilepath, destFilepath)
    }
    catch (e) {
      if (e.code == 'ENOENT') {
        var error = Error(`No such file: ${srcFilepath}`)
        error.name = 'noSuchFile'
        throw error
      }
      else {
        throw e
      }
    }
  }
}

class FleetingNote{
  constructor(fullPath, col) {
    this.path = fullPath
    this.collection = col
    this.filename = path.basename(fullPath)
    this.mime = mime.lookup(fullPath) || 'application/octet-stream'
    this.name = this.filename.replace(/\.[^/.]+$/, "")
    var d = moment(this.name, 'YYYY-MM-DD HH,mm,ss')
    if (d.isValid()) {
      this.date = d.toDate()
    }
    else {
      var { birthtime } = fs.statSync(fullPath)
      this.date = birthtime
    }
  }
  delete() {
    fs.unlinkSync(this.path)
    this.deleted = true
  }
  rename(newName) {
    fs.renameSync(this.path, path.join(path.dirname(this.path), newName))
  }
  sendToStack(stack) {
    var stackDir = path.join(this.collection.paths.stacks, stack)
    !fs.existsSync(stackDir) && fs.mkdirSync(stackDir, { recursive: true })
    fs.renameSync(this.path, path.join(stackDir, this.filename))
  }
  get isText() {
    return this.mime.startsWith('text/')
  }
  get isImage() {
    return this.mime.startsWith('image/')
  }
  get inInbox() {
    return (this.collection.collectionJson.specialStacks['inbox'] == this.stack)
  }
  get inStacks() {
    return this.path.startsWith(this.collection.paths.stacks)
  }
  get stack() {
    if (this.inStacks) {
      var p = path.dirname(this.path)
      return path.relative(this.collection.paths.stacks, p)
    }
  }
  get content() {
    return fs.readFileSync(this.path, 'utf8')
  }
  get contentBase64() {
    return fs.readFileSync(this.path, 'base64')
  }
  setContent(content) {
    fs.writeFileSync(this.path, content, 'utf8')
  }
}

class Tags{
  constructor(collection) {
    this.path = path.join(collection.path, '.tags.json')
    if (!fs.existsSync(this.path)) {
      var emptyTagsJson = {
        "pVersion": pVersion,
        "tags": {},
      }
      this.tagsJson = emptyTagsJson
      fs.writeFileSync(this.path, JSON.stringify(this.tagsJson, null, ' '), 'utf8')
    }
    else {
      this.tagsJson = JSON.parse(fs.readFileSync(this.path))
    }
  }
  getTag(tag) {
    if (Object.keys(this.tagsJson.tags).includes(tag)) {
      return this.tagsJson.tags[tag]
    }
  }
  setTag(tag, props) {
    this.tagsJson.tags[tag] = props
  }
  updateTag(tag, props) {
    var tagProps = this.tagsJson.tags[tag]
    if (!tagProps) {
      this.tagsJson.tags[tag] = props
    }
    else {
      for (var p of Object.keys(props)) {
        tagProps[p] = props[p]
      }
      this.tagsJson.tags[tag] = tagProps
    }
  }
  save() {
    fs.writeFileSync(this.path, JSON.stringify(this.tagsJson, null, ' '), 'utf8')
  }

}

class Port{
  constructor(properties) {
    this.name = properties.name
    this.id = properties.id
    this.path = path.join(pensieveConfigPath, 'ports', properties.id)
    this.relativeTargetPath = properties.targetPath
    this.collectionName = properties.collectionName
    !fs.existsSync(this.path) && fs.mkdirSync(this.path, { recursive: true })
  }
  sendToPort(fn) {
    fn.removeAllRelations()
    fs.copyFileSync(fn.path, path.join(this.path, fn.filename))
    fs.unlinkSync(fn.path)
    if(fn.hasMetadata) {
      fs.copyFileSync(fn.metadataPath, path.join(this.path, path.basename(fn.metadataPath)))
      fs.unlinkSync(fn.metadataPath)
    }
  }
  emptyPort(collection) {
    var targetPath = path.join(collection.path, this.relativeTargetPath)
    var listing = fs.readdirSync(this.path)
    for (let f of listing) {
      let fullPath = path.join(this.path, f)
      fs.copyFileSync(fullPath, path.join(targetPath, f))
      fs.unlinkSync(fullPath)
    }
  }
}

const portsJsonPath = path.join(pensieveConfigPath, 'ports/ports.json')
if(fs.existsSync(portsJsonPath)) {
  const portsJson = JSON.parse(fs.readFileSync(portsJsonPath, 'utf8'))
  var ports = []
  if (portsJson.ports) {
    for (let p of portsJson.ports) {
      ports.push(new Port(p))
    }
  }
}


module.exports = {
  NoteCollection: NoteCollection,
  newCollection: newCollection,
  utils: utils,
  ports: ports,
}
