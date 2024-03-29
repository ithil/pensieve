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
const {v4: uuidv4} = require('uuid')
const {NodeVM} = require('vm2')

const pVersion = '0.1'
const pensieveConfigPath = getAppDataPath('pensieve')

var md = new MarkdownIt({linkify: true, html: true})
md.use( require('markdown-it-bracketed-spans') )
md.use( require('markdown-it-attrs'), {
  // optional, these are default options
  leftDelimiter: '{{',
  rightDelimiter: '}}',
  allowedAttributes: []  // empty array = all attributes are allowed
})
md.use( require('markdown-it-title'), {
  level: 0,
  excerpt: 1,
})


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
  },
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
        var note = new Note(thisPath, this)
        this.events.emit('stacksItemAdd', note, collection.stacksWatcher)
      }
      else if (event == 'change') {
        var note = new Note(thisPath, this)
        this.events.emit('stacksItemChange', note, collection.stacksWatcher)
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
  getNoteByName(name) {
    var $this = this
    var walk = function(thisPath) {
      var listing = fs.readdirSync(thisPath, {withFileTypes: true})
      for (let i of listing) {
        if (i.isFile() && new RegExp(`^${name}\\.`).test(i.name)) {
          return new Note(path.join(thisPath, i.name), $this)
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
  getNoteByPath(notePath) {
    if (!path.isAbsolute(notePath)) {
      notePath = path.join(this.path, notePath)
    }
    if (fs.existsSync(notePath)) {
      return new Note(notePath, this)
    }
  }
  resolveNoteLink(link) {
    let pathWithoutExtension = path.join(this.paths.stacks, link)
    for (let ext of ['md', 'canvas', 'tasklist', 'json']) {
      let fullPath = `${pathWithoutExtension}.${ext}`
      if (fs.existsSync(fullPath)) {
        return new Note(fullPath, this)
      }
    }
  }
  searchNotesRaw(searchString, regexp) {
    var $this = this
    return new Promise((resolve, reject) => {
      let results = []
      var walk = function(thisPath) {
        var listing = fs.readdirSync(thisPath, {withFileTypes: true})
        for (let i of listing) {
          if (i.isFile() && i.name.endsWith('.md')) {
            let content = fs.readFileSync(path.join(thisPath, i.name), 'utf8')
            if (regexp && new RegExp(searchString).test(content)) {
              results.push(path.join(thisPath, i.name))
            }
            else if (!regexp && content.includes(searchString)) {
              results.push(path.join(thisPath, i.name))
            }
          }
          else if (i.isDirectory()) {
            let dirWalk = walk(path.join(thisPath, i.name))
            if (dirWalk) {
              return dirWalk
            }
          }
        }
      }
      walk($this.paths.stacks)
      resolve(results)
    })
  }
  searchNotes(searchString, regexp) {
    var $this = this
    return this.searchNotesRaw(searchString, regexp).then(results => {
      var notes = []
      for (let n of results) {
        notes.push(new Note(n, $this))
      }
      return notes
    })
  }
  getMostRecentlyChangedNotesRaw() {
    var $this = this
    return new Promise((resolve, reject) => {
      let results = []
      var walk = function(thisPath) {
        var listing = fs.readdirSync(thisPath, {withFileTypes: true})
        for (let i of listing) {
          if (i.isFile() && i.name.endsWith('.md')) {
            let fullPath = path.join(thisPath, i.name)
            results.push({
              path: fullPath,
              mtime: fs.statSync(fullPath).mtime,
            })
          }
          else if (i.isDirectory()) {
            let dirWalk = walk(path.join(thisPath, i.name))
            if (dirWalk) {
              return dirWalk
            }
          }
        }
      }
      walk($this.paths.stacks)
      results.sort((a, b) => b.mtime - a.mtime)
      results = results.map(i => i.path)
      resolve(results)
    })
  }
  getMostRecentlyChangedNotes(max = 10) {
    var $this = this
    return this.getMostRecentlyChangedNotesRaw().then(results => {
      var notes = []
      for (let i = 0; i < results.length && i < max; i++) {
        notes.push(new Note(results[i], $this))
      }
      return notes
    })
  }
  getAllNotes({excludeStacks = ['calendar']} = {}) {
    var $this = this
    return new Promise((resolve, reject) => {
      let results = []
      var walk = function(thisPath) {
        var listing = fs.readdirSync(thisPath, {withFileTypes: true})
        for (let i of listing) {
          let fullPath = path.join(thisPath, i.name)
          if (i.isFile() && !i.name.startsWith('.')) {
            results.push({
              path: fullPath,
              mtime: fs.statSync(fullPath).mtime,
            })
          }
          else if (i.isDirectory() && !excludeStacks.includes(path.relative($this.paths.stacks, fullPath))) {
            let dirWalk = walk(path.join(thisPath, i.name))
            if (dirWalk) {
              return dirWalk
            }
          }
        }
      }
      walk($this.paths.stacks)
      results.sort((a, b) => b.mtime - a.mtime)
      results = results.map(i => new Note(i.path, $this))
      resolve(results)
    })
  }
  createDateNode(stack, date) {
    moment.locale('de')
    var date = moment(date)
    var monthPath = path.join(this.paths.stacks, stack, date.format('YYYY'), date.format('MM'))
    if (!fs.existsSync(monthPath)) {
      fs.mkdirSync(monthPath, { recursive: true })
    }
    var dayPath = path.join(monthPath, `${date.format('DD')}.md`)
    if (!fs.existsSync(dayPath)) {
      fs.writeFileSync(dayPath, `# ${date.format('dddd, D. MMMM YYYY')}` ,'utf8')
    }
    return new Note(dayPath, this)
  }
  getDateNode({stack = 'calendar', date, day, month, year} = {}) {
    if (date) {
      day = date.getDate()
      month = date.getMonth() + 1
      year = date.getUTCFullYear()
    }
    let dayPath = path.join(this.paths.stacks, stack, `${year}`, `${month}`.padStart(2, '0'), `${day}`.padStart(2, '0')+'.md')
    if (fs.existsSync(dayPath)) {
      return new Note(dayPath, this)
    }
    else {
      return null
    }
  }
  getStackStyleProps(stackRelativePath) {
    if (this._stackStyleProps && this._stackStyleProps[stackRelativePath]) {
      return this._stackStyleProps[stackRelativePath]
    }
    else {
      let stack = this.stacks.getStackByPath(stackRelativePath)
      let metadata = stack.metadata
      let style = metadata?.get('style') || {}
      this._stackStyleProps[stackRelativePath] = style
      return this._stackStyleProps[stackRelativePath]
    }
  }
  getAllTemplates() {
    var templates = []
    var templateDir = path.join(this.paths.stacks, '.internal', 'templates')
    if (fs.existsSync(templateDir)) {
      var listing = fs.readdirSync(templateDir)
      for (let fn of listing.filter(n => n.endsWith('.json'))) {
        let filePath = path.join(templateDir, fn)
        templates.push(new Template(filePath, this))
      }
    }
    return templates
  }
  newTemplate(title = "New Template") {
    var templateDir = path.join(this.paths.stacks, '.internal', 'templates')
    !fs.existsSync(templateDir) && fs.mkdirSync(templateDir, { recursive: true })
    var fn = `${uuidv4()}.json`
    var filePath = path.join(templateDir, fn)
    var templateObj = {
      title,
      type: 'note',
      enabled: true,
      fromDate: false,
      stack: 'Inbox',
      generator: "handleResponse({\n  status: 'done',\n  payload: {\n    content: '# Test',\n    //stack: 'Inbox',\n  },\n})",
    }
    fs.writeFileSync(filePath, JSON.stringify(templateObj, null, ' '))
    return new Template(filePath, this)
  }
  saveCollectionJson() {
    fs.writeFileSync(this.collectionJsonPath, JSON.stringify(this.collectionJson, null, ' '), 'utf8')
  }
}

class Stacks{
  constructor(collection) {
    this.collection = collection
    this.path = collection.paths.stacks || path.join(this.collection.path, 'Stacks')
  }
  getStacks(stacksOnly) {
    var collection = this.collection
    var getList = function(givenPath) {
      var listing = fs.readdirSync(givenPath, {withFileTypes: true})
      listing = listing.filter(f => /^[^\.]/.test(f.name))
      var list = []
      for (let i of listing) {
        if (i.isFile() && !stacksOnly) {
          list.push(new Note(path.join(givenPath, i.name), collection))
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
    this.style = this.metadata.get('style') || {}
  }
  getContent() {
    var collection = this.collection
    var getList = function(givenPath) {
      var listing = fs.readdirSync(givenPath, {withFileTypes: true})
      listing = listing.filter(f => /^[^\.]/.test(f.name))
      var list = []
      for (let i of listing) {
        if (i.isFile()) {
          list.push(new Note(path.join(givenPath, i.name), collection))
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
  createCanvas({filename, title}) {
    filename = filename || `${moment().format('YYYY-MM-DD HH,mm,ss')}.canvas`
    title = title || 'Untitled Canvas'
    var filepath = path.join(this.path, filename)
    var canvasObj = {
      title: title,
      elements: [
        {
          id: uuidv4(),
          type: 'markdown',
          text: `# ${title}`,
          x: 200,
          y: 200,
          width: 200,
          height: 100,
          creationDate: new Date((new Date()).getTime() + 1000), // To avoid having the same time id as the canvas when converting to note
          modificationDate: new Date((new Date()).getTime() + 1000),
        },
      ],
      edges: [],
      style: {},
    }
    fs.writeFileSync(filepath, JSON.stringify(canvasObj), 'utf8')
    return filepath
  }
  createTasklist({filename, title}) {
    filename = filename || `${moment().format('YYYY-MM-DD HH,mm,ss')}.tasklist`
    title = title || 'Untitled Tasklist'
    var filepath = path.join(this.path, filename)
    var tasklistObj = {
      title: title,
      creationDate: new Date((new Date()).getTime()),
      modificationDate: new Date((new Date()).getTime()),
      list: [
      ],
    }
    fs.writeFileSync(filepath, JSON.stringify(tasklistObj), 'utf8')
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
  get lastModified() {
    var notes = this.getContent().filter(i => i instanceof Note)
    var lastModified = 0
    for (let n of notes) {
      if (n.lastModified > lastModified) {
        lastModified = n.lastModified
      }
    }
    return lastModified
  }
  get lastAddedTo() {
    var notes = this.getContent().filter(i => i instanceof Note)
    var lastAddedTo = 0
    for (let n of notes) {
      if (n.creationDate > lastAddedTo) {
        lastAddedTo = n.creationDate
      }
    }
    return lastAddedTo
  }
}

class Note{
  constructor(fullPath, col) {
    this.path = fullPath
    this.collection = col
    this.filename = path.basename(fullPath)
    this.mime = mime.lookup(fullPath) || 'application/octet-stream'
    this.name = this.filename.replace(/\.[^/.]+$/, "")
    var { birthtime, atime, mtime, ctime } = fs.statSync(fullPath)
    this.atime = atime
    this.mtime = mtime
    this.ctime = ctime
    var d = moment(this.name, 'YYYY-MM-DD HH,mm,ss')
    if (d.isValid()) {
      this.date = d.toDate()
    }
    else {
      this.date = birthtime
    }
    this.relativePath = path.relative(this.collection.path, this.path)
    this.metadataPath = path.join(path.dirname(this.path), `.${this.name}.json`)
  }
  delete() {
    fs.unlinkSync(this.path)
    this.deleted = true
    if(this.hasMetadata) {
      var metadata = this.getMetadata()
      fs.unlinkSync(this.metadataPath)
      this.fixLinks(this.relativePath, null, metadata)
    }
    // Delete links here...
  }
  removeAllRelations() {
    if(this.hasMetadata) {
      var metadata = this.getMetadata()
      this.fixLinks(this.relativePath, null, metadata)
    }
  }
  rename(newName) {
    fs.renameSync(this.path, path.join(path.dirname(this.path), newName))
    if(this.hasMetadata) {
      // ??? Needs some thinking
      // fs.renameSync(this.metadataPath, path.join(path.dirname(this.path)))
    }
  }
  sendToStack(stack) {
    var oldRelativePath = this.relativePath
    var stackDir = path.join(this.collection.paths.stacks, stack)
    var newRelativePath = path.relative(this.collection.path, path.join(stackDir, this.filename))
    !fs.existsSync(stackDir) && fs.mkdirSync(stackDir, { recursive: true })
    fs.renameSync(this.path, path.join(stackDir, this.filename))
    if(this.hasMetadata) {
      var metadata = this.getMetadata()
      fs.renameSync(this.metadataPath, path.join(stackDir, path.basename(this.metadataPath)))
      this.fixLinks(oldRelativePath, newRelativePath, metadata)
    }
  }
  fixLinks(oldRelativePath, newRelativePath, metadata) {
    var relations = []
    for (let c of [metadata.links, metadata.backlinks]) {
      if (c && c.length > 0) {
        relations = relations.concat(c.map(i => i[0]))
      }
    }
    relations = [...new Set(relations)]
    for (let r of relations) {
      let note = this.collection.getNoteByPath(r)
      note.replaceLink(oldRelativePath, newRelativePath)
    }
  }
  replaceLink(oldRelativePath, newRelativePath) {
    if (this.hasMetadata) {
      var metadata = this.getMetadata()
      if (metadata.links) {
        metadata.links = metadata.links.map(l => {
          if (l[0] == oldRelativePath) {
            l[0] = newRelativePath
          }
          return l
        })
        if (newRelativePath === null) {
          metadata.links = metadata.links.filter(l => l[0] !== null)
        }
      }
      if (metadata.backlinks) {
        metadata.backlinks = metadata.backlinks.map(l => {
          if (l[0] == oldRelativePath) {
            l[0] = newRelativePath
          }
          return l
        })
        if (newRelativePath === null) {
          metadata.backlinks = metadata.backlinks.filter(l => l[0] !== null)
        }
      }
      this.setMetadata(metadata)
      if (this.isCanvas) {
        let {canvasObj} = this
        for (let el of canvasObj.elements) {
          if (el.path == oldRelativePath) {
            if (newRelativePath === null) {
              el.type = 'markdown'
              el.text = `The note \`${el.path}\` has been deleted.`
            }
            else {
              el.path = newRelativePath
            }
          }
        }
        this.setContent(JSON.stringify(canvasObj, null, 2))
      }
    }
  }
  get isText() {
    return this.mime.startsWith('text/')
  }
  get isImage() {
    return this.mime.startsWith('image/')
  }
  get isAudio() {
    return this.mime.startsWith('audio/')
  }
  get isCanvas() {
    return this.filename.endsWith('.canvas')
  }
  get isTasklist() {
    return this.filename.endsWith('.tasklist')
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
  get noteLink() {
    return `/${this.stack}/${this.name}`
  }
  get content() {
    return fs.readFileSync(this.path, 'utf8')
  }
  get contentBase64() {
    return fs.readFileSync(this.path, 'base64')
  }
  get contentRendered() {
    return md.render(this.content)
  }
  get canvasObj() {
    if (this.isCanvas) {
      return JSON.parse(this.content)
    }
  }
  get tasklistObj() {
    if (this.isTasklist) {
      return JSON.parse(this.content)
    }
  }
  setContent(content) {
    fs.writeFileSync(this.path, content, 'utf8')
  }
  get hasMetadata() {
    return fs.existsSync(this.metadataPath)
  }
  setMetadata(newMetadata) {
    // If metadata.links and metadata.backlinks empty => delete file
    fs.writeFileSync(this.metadataPath, JSON.stringify(newMetadata, null, ' '), 'utf8')
  }
  getMetadata() {
    if (this.hasMetadata) {
      return JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'))
    }
    else {
      return null
    }
  }
  addLink(target, edgeProperties) {
    var metadata = this.getMetadata() || {links: []}
    if (path.isAbsolute(target)) {
      target = path.relative(this.collection.path, target)
    }
    if (!metadata.links) {
      metadata.links = []
    }
    var indexIfExists = metadata.links.findIndex(([link]) => {
      if (path.isAbsolute(link)) {
        link = path.relative(this.collection.path, link)
      }
      return target == link
    })
    if (indexIfExists > -1) {
      metadata.links[indexIfExists][1] = edgeProperties
    }
    else {
      metadata.links.push([target, edgeProperties ? edgeProperties : []])
    }
    this.setMetadata(metadata)
    // Add backlinks here as well
    var note = this.collection.getNoteByPath(target)
    if (note) {
      note.addBacklink(this.relativePath, edgeProperties)
    }
    else {
      console.error(`Error backlinking: No such note: ${target}`)
    }
  }
  removeLink(target) {
    if (path.isAbsolute(target)) {
      target = path.relative(this.collection.path, target)
    }
    var metadata = this.getMetadata()
    if (metadata && metadata.links) {
      var newLinks = metadata.links.filter(i => {
        let l = i[0]
        if (path.isAbsolute(l)) {
          l = path.relative(this.collection.path, l)
        }
        return l != target
      })
      metadata.links = newLinks
      this.setMetadata(metadata)
    }
    var note = this.collection.getNoteByPath(target)
    if (note) {
      note.removeBacklink(this.relativePath)
    }
    else {
      console.error(`Error removing backlink: No such note: ${target}`)
    }
    // Add somewhere here: Remove metadata alltogether if it's empty
  }
  addBacklink(target, edgeProperties) {
    var metadata = this.getMetadata() || {backlinks: []}
    if (path.isAbsolute(target)) {
      target = path.relative(this.collection.path, target)
    }
    if (!metadata.backlinks) {
      metadata.backlinks = []
    }
    var indexIfExists = metadata.backlinks.findIndex(([backlink]) => {
      if (path.isAbsolute(backlink)) {
        link = path.relative(this.collection.path, backlink)
      }
      return target == backlink
    })
    if (indexIfExists > -1) {
      metadata.backlinks[indexIfExists][1] = edgeProperties
    }
    else {
      metadata.backlinks.push([target, edgeProperties])
    }
    this.setMetadata(metadata)
  }
  removeBacklink(target) {
    if (path.isAbsolute(target)) {
      target = path.relative(this.collection.path, target)
    }
    var metadata = this.getMetadata()
    if (metadata && metadata.backlinks) {
      var newBacklinks = metadata.backlinks.filter(i => {
        let l = i[0]
        if (path.isAbsolute(l)) {
          l = path.relative(this.collection.path, l)
        }
        return l != target
      })
      metadata.backlinks = newBacklinks
      this.setMetadata(metadata)
    }
    // Add somewhere here: Remove metadata alltogether if it's empty
  }
  moveLink(targetRelativePath, delta) {
    var move = function(array, index, delta) {
      //ref: https://gist.github.com/albertein/4496103
      var newIndex = index + delta;
      if (newIndex < 0 || newIndex == array.length) return; //Already at the top or bottom.
      var indexes = [index, newIndex].sort((a, b) => a - b); //Sort the indixes (fixed)
      array.splice(indexes[0], 2, array[indexes[1]], array[indexes[0]]); //Replace from lowest index, two elements, reverting the order
    }
    var array_move = function(arr, old_index, new_index) {
      if (new_index >= arr.length) {
        var k = new_index - arr.length + 1;
        while (k--) {
          arr.push(undefined);
        }
      }
      arr.splice(new_index, 0, arr.splice(old_index, 1)[0]);
    }
    if (this.hasMetadata) {
      var metadata = this.getMetadata()
      if (metadata.links) {
        var linkIndex = metadata.links.findIndex(l => (l[0] == targetRelativePath) || (l[0] == path.join(this.collection.path, targetRelativePath))) // This just as a workaround because of erroneous absolute linking in pensine...
        if (linkIndex > -1) {
          let newIndex = linkIndex + delta
          array_move(metadata.links, linkIndex, newIndex)
        }
      }
      if (metadata.backlinks) {
        var backlinkIndex = metadata.backlinks.findIndex(l => (l[0] == targetRelativePath) || (l[0] == path.join(this.collection.path, targetRelativePath)))
        if (backlinkIndex > -1) {
          let newIndex = linkIndex + delta
          array_move(metadata.backlinks, backlinkIndex, newIndex)
        }
      }
      this.setMetadata(metadata)
    }
  }
  get relations() {
    if (this._relations) {
      return this._relations
    }
    var relations = []
    if (this.hasMetadata) {
      var metadata = this.getMetadata()
      if (metadata.links) {
        for (let link of metadata.links) {
          var noteName = link[0]
          var edgeProperties = link[1]
          var note = this.collection.getNoteByPath(noteName)
          relations.push({note: note, properties: edgeProperties, direction: 'link'})
        }
      }
      if (metadata.backlinks) {
        for (let link of metadata.backlinks) {
          var noteName = link[0]
          var edgeProperties = link[1]
          var note = this.collection.getNoteByPath(noteName)
          relations.push({note: note, properties: edgeProperties, direction: 'backlink'})
        }
      }
    }
    this._relations = relations
    return relations
  }
  get rawRelations() {
    if (this._rawRelations) {
      return this._rawRelations
    }
    var rawRelations = []
    if (this.hasMetadata) {
      var metadata = this.getMetadata()
      if (metadata.links) {
        for (let link of metadata.links) {
          var noteName = link[0]
          var edgeProperties = link[1]
          rawRelations.push({notePath: noteName, properties: edgeProperties, direction: 'link'})
        }
      }
      if (metadata.backlinks) {
        for (let link of metadata.backlinks) {
          var noteName = link[0]
          var edgeProperties = link[1]
          rawRelations.push({notePath: noteName, properties: edgeProperties, direction: 'backlink'})
        }
      }
    }
    this._rawRelations = rawRelations
    return rawRelations
  }
  get numberOfRelations() {
    if (this._relations) {
      return this._relations.length
    }
    if (this.hasMetadata) {
      var metadata = this.getMetadata()
      return (metadata?.links?.length ?? 0 ) + (metadata?.backlinks?.length ?? 0 )
    }
    return 0
  }
  get relatedDates() {
    var rawRelations = this.rawRelations
    var pattern = /calendar\/(\d\d\d\d)\/(\d\d)\/(\d\d)/
    var relatedDates = []
    for (let r of rawRelations) {
      let match = r.notePath.match(pattern)
      if (match) {
        relatedDates.push(new Date(match[1], match[2]-1, match[3]))
      }
    }
    return relatedDates
  }
  get webLinks() {
    var tokens = md.parse(this.content, {})
    return tokens.map(t => t.children ? t.children : [])
      .flat().filter(t => t.type == 'link_open')
      .map(t => t.attrs[0][1])
  }
  get title() {
    if (this.isCanvas) {
      return this.canvasObj.title || 'Canvas'
    }
    else if (this.isTasklist) {
      return this.tasklistObj.title || 'Tasklist'
    }
    else if (this.isText) {
      var env = {}
      var tokens = md.render(this.content, env)
      return env.title || null
    }
    else if (this.isAudio) {
      return 'Audio File'
    }
    else if (this.isImage) {
      return 'Image File'
    }
  }
  get abstract() {
    if (this.isCanvas) {
      return this.canvasObj.title || 'Canvas'
    }
    else if (this.isTasklist) {
      return this.tasklistObj.title || 'Tasklist'
    }
    else if (this.isText) {
      var env = {}
      var tokens = md.render(this.content, env)
      return env.title || ((env.excerpt && env.excerpt.length > 0) ? env.excerpt[0] : this.content.slice(0, 80))
    }
    else if (this.isAudio) {
      return 'Audio File'
    }
    else if (this.isImage) {
      return 'Image File'
    }
  }
  get lastModified() {
    var { mtime, ctime } = fs.statSync(this.path)
    return mtime
  }
  get creationDate() {
    var { birthtime } = fs.statSync(this.path)
    return birthtime
  }
  addAppendixNote() {
    var stackDir = path.join(this.collection.paths.stacks, 'appendix')
    !fs.existsSync(stackDir) && fs.mkdirSync(stackDir, { recursive: true })
    var stack = this.collection.stacks.getStackByPath('appendix')
    var filepath = stack.sendText('')
    this.addLink(filepath, ['appendix'])
    return filepath
  }
  setAsBookmark(add = null) {
    var stackDir = path.join(this.collection.paths.stacks, '.internal')
    !fs.existsSync(stackDir) && fs.mkdirSync(stackDir, { recursive: true })
    var stack = this.collection.stacks.getStackByPath('.internal')
    var bookmarksPath = path.join(stackDir, 'bookmarks.md')
    if (!fs.existsSync(bookmarksPath)) {
      // fs.writeFileSync(bookmarksPath, '# Global Bookmarks', 'utf8')
      stack.sendText('# Global Bookmarks', 'bookmarks.md')
    }
    if (add) {
      this.addLink(bookmarksPath, ['bookmark'])
    }
    else if (add === false) (
      this.removeLink(bookmarksPath)
    )
    else {
      if (this.rawRelations.findIndex(r => r.notePath == path.relative(this.collection.path, bookmarksPath)) > -1) {
        this.removeLink(bookmarksPath)
      }
      else {
        this.addLink(bookmarksPath, ['bookmark'])
      }
    }
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
  sendToPort(note) {
    note.removeAllRelations()
    fs.copyFileSync(note.path, path.join(this.path, note.filename))
    fs.unlinkSync(note.path)
    if(note.hasMetadata) {
      fs.copyFileSync(note.metadataPath, path.join(this.path, path.basename(note.metadataPath)))
      fs.unlinkSync(note.metadataPath)
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

class Template{
  constructor(filePath, collection) {
    if (fs.existsSync(filePath)) {
      let fileContent = fs.readFileSync(filePath)
      this.templateObj = JSON.parse(fileContent)
      this.savedTemplateObj = JSON.parse(fileContent)
      this.path = filePath
      this.id = path.basename(filePath).replace(/\.[^/.]+$/, "")
    }
    this.collection = collection
  }
  setTemplate(templateObj = this.templateObj) {
    fs.writeFileSync(this.path, JSON.stringify(templateObj, null, ' '))
    this.templateObj = templateObj
    this.savedTemplateObj = templateObj
  }
  getTemplate() {
    return this.templateObj
  }
  execute({args, callback}) {
    var $this = this
    var handleResponse = (res) => {
      console.log(res)
      if (res.status == 'done') {
        let stack = $this.collection.stacks.getStackByPath(res.payload.stack || 'Inbox')
        let notePath = stack.sendText(res.payload.content)
        let note = $this.collection.getNoteByPath(notePath)
        if (res.payload.linkToDates) {
          for (let d of res.payload.linkToDates) {
            let dateNote = $this.collection.createDateNode('calendar', d)
            note.addLink(dateNote.relativePath, ['date'])
          }
        }
        if (res.payload.relations) {
          for (let r of res.payload.relations) {
            if (typeof r  === 'string') {
              var noteLink = r
              var edgeProperties = []
            }
            else if (r instanceof Array) {
              var noteLink = r.shift()
              var edgeProperties = [...r]
            }
            let relatedNote = $this.collection.resolveNoteLink(noteLink || '')
            if (relatedNote) {
              note.addLink(relatedNote.relativePath, edgeProperties)
            }
          }
        }
        callback(note)
      }
      else if (res.status == 'error') {
        //
      }
    }
    const vm = new NodeVM({
      sandbox: {
        args,
        moment,
        handleResponse,
        collection: this.collection,
      }
    })
    return vm.run(this.templateObj.generator)
  }
  duplicate(title = `${this.templateObj.title} (2)`) {
    var templateDir = path.join(this.collection.paths.stacks, '.internal', 'templates')
    !fs.existsSync(templateDir) && fs.mkdirSync(templateDir, { recursive: true })
    var fn = `${uuidv4()}.json`
    var filePath = path.join(templateDir, fn)
    fs.writeFileSync(filePath, JSON.stringify({...this.templateObj, title}, null, ' '))
    return new Template(filePath, this.collection)
  }
  delete() {
    fs.unlinkSync(this.path)
    this.deleted = true
  }
}


module.exports = {
  NoteCollection: NoteCollection,
  newCollection: newCollection,
  utils: utils,
  ports: ports,
}
