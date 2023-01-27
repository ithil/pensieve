const fs = require('fs')
const path = require('path')
const { EventEmitter } = require("events")
const MarkdownIt = require('markdown-it')
const moment = require('moment')
const unorm = require('unorm')
const Fuse = require('fuse.js')
const chokidar = require('chokidar')
const mime = require('mime-types')
const git = require('isomorphic-git')
const http = require('isomorphic-git/http/node')

const pVersion = '0.1'
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
      this.path = path.dirname(this.collectionJsonPath)
      this.paths = utils.objectMap(this.collectionJson.paths, p => path.resolve(this.path, p))
      this.stacks = new Stacks(this)
      if (this.collectionJson.useGit) {
        this.repo = { fs, dir: this.path }
      }
      this.events = new EventEmitter()
    }
    catch (e) {
      throw e
    }
  }
        }
        }
      }
      else {
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

module.exports = {
  Note: Note,
  NoteCollection: NoteCollection,
  Tags: Tags,
  newCollection: newCollection,
  utils: utils,
}
