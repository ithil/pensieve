const fs = require('fs')
const path = require('path')
const MarkdownIt = require('markdown-it')
var md = new MarkdownIt()
const moment = require('moment')
const Fuse = require('fuse.js')

const pVersion = '0.1'
var filenameRegex = /^((\d+)[0-9a-z]*)\.([\w\u00C0-\u02AF\u0370-\u04FF\u00A0-\uFADF\. ]+)\.(md|html|rtf)/m
// TODO: filenameRegex needs to be defined more dynamically
var identifierRegex = /([\w\u00C0-\u02AF\u0370-\u04FF\u00A0-\uFADF\.]+)/
var tagRegex = new RegExp(`#${identifierRegex.source}`)
var anchorRegex = new RegExp(`\\$${identifierRegex.source}`)
var stickerRegex = new RegExp(`{{((\\s*${tagRegex.source}\\s*)+)}}`, 'g')
var anchorInlineRegex = new RegExp(`{{(\\s*${anchorRegex.source}\\s*)}}`, 'g')

var quoteRegex = /["„“«](.+)["“”»]\s*\(([\w\. ]+)\)/g

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
  adjectives: fs.readFileSync(path.join(__dirname, '../assets/adjectives.txt'), 'utf8')
    .split('\n').filter(s => s != ''),
  nouns: fs.readFileSync(path.join(__dirname, '../assets/nouns.txt'), 'utf8')
    .split('\n').filter(s => s != ''),
  createLabelFromId(id) {
    // This function needs to be rewritten, it's doing weird things
    id = Number(id) - 1
    var adj = this.adjectives
    var nou = this.nouns
    if (id + 1 > adj.length*nou.length) {
      return `${adj[adj.length-1]}${nou[nou.length-1]}`
    }
    var row = parseInt(id/adj.length)
    var col = id - row * adj.length
    return `${adj[col]}${nou[row]}`
  },
  createEmptyMetadata: function(id) {
    var metadata = {
      "pVersion": pVersion,
      "id": id,
      "format": "markdown",
      "creationDate": new Date(),
      "languages": ["en"],
      "references": {},
      "media": {},
      "tags": [],
    }
    return metadata
  },
  createNewCollectionJson() {
    var collectionJson = {
      "pVersion": pVersion,
      "name": "My Note Collection",
      "creationDate": new Date(),
      "paths": {
        "all": "./All",
        "inbox": "./Inbox",
        "archive": "./Archived",
        // "categories": ".",
        "cache": "./.cache",
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
  constructor(dir) {
    try {
      this.collectionJsonPath = utils.searchCollectionJson(dir)
      this.collectionJson = JSON.parse(fs.readFileSync(this.collectionJsonPath))
      this.path = path.dirname(this.collectionJsonPath)
      this.paths = utils.objectMap(this.collectionJson.paths, p => path.resolve(this.path, p))
      this.allNotes = this.getAllNotes()
    }
    catch (e) {
      throw e
    }
  }
  fuzzySearchForNote(term) {
    term = term || ''
    var options = {
      keys: [
        {
          name: "name",
          weight: 3,
        },
        "metadata.tags",
      ]
    }
    var fuse = new Fuse(this.allNotes, options)
    return fuse.search(term)
  }
  getHighestId() {
    var listing = fs.readdirSync(this.paths.all)
    var topLevelIds = listing.map(f => filenameRegex.exec(f)).filter(f => Array.isArray(f)).map(f => f[2])
    if (topLevelIds.length < 1) {
      return 0
    }
    return Math.max.apply(null, topLevelIds)
  }
  newNote(label, id) {
    var id = id || this.getHighestId() + 1
    label = label || utils.createLabelFromId(id)
    var contentPath = path.join(this.paths.all, `${id}.${label}.md`)
    var metadataPath = path.join(this.paths.all, `.${id}.json`)
    fs.writeFileSync(metadataPath, JSON.stringify(utils.createEmptyMetadata(id), null, ' '), 'utf8')
    fs.writeFileSync(contentPath, '', 'utf8')
    return new Note(contentPath, this)
  }
  categorize(note, category) {
    var contentPath = note.contentPath
    var catPath = path.join(this.path, category) //Maybe use a separate this.paths.category in the future?
    var linkPath = path.join(catPath, note.filename)
    try {
      !fs.existsSync(catPath) && fs.mkdirSync(catPath, { recursive: true })
      !fs.existsSync(linkPath) && fs.symlinkSync(contentPath, linkPath)
    }
    catch (e) {
      var err = new Error(`Can't put note ${note.filename} into category ${category}`)
      err.name = 'categorizationError'
      err.stack = e.stack
      throw err
    }
  }
  autoCategorize(notes) {
    var rulesPath = path.join(this.path, '.autoCategorize.json')
    if (fs.existsSync(rulesPath)) {
      var autoCategorizeJson = JSON.parse(fs.readFileSync(rulesPath))
      var rules = autoCategorizeJson.rules
      for (var n of notes) {
        for (var r of rules) {
          if(r.hasTags.every(t => n.metadata.tags.includes(t))) {
            for (var c of r.categorize) {
              this.categorize(n, c)
            }
          }
        }
      }
    }
    else {
      var autoCategorizeJson = {
        "version": pVersion,
        "rules": [],
      }
      fs.writeFileSync(rulesPath, JSON.stringify(autoCategorizeJson, null, ' '), 'utf8')
    }
  }
  getNoteById(id) {
    var listing = fs.readdirSync(this.paths.all)
    for (var f of listing) {
      var match = filenameRegex.exec(f)
      if (match && match[2] == String(id)) {
        var contentPath = path.join(this.paths.all, match[0])
        return new Note(contentPath, this)
      }
    }
  }
  getNoteByFilename(filename) {
    var filepath = path.isAbsolute(filename) ? filename : path.join(this.paths.all, filename)
    filename = path.basename(filename)
    var match = filenameRegex.exec(filename)
    if (match && fs.existsSync(filepath)) {
      var contentPath = path.join(this.paths.all, match[0])
      return new Note(contentPath, this)
    }
  }
  getNotesByLabel(label) {
    var listing = fs.readdirSync(this.paths.all)
    var notes = []
    for (var f of listing) {
      var match = filenameRegex.exec(f)
      if (match && match[3] == String(label)) {
        var contentPath = path.join(this.paths.all, match[0])
        notes.push(new Note(contentPath, this))
      }
    }
    return notes
  }
  resolveToNote(name) {
    name = String(name)
    if (fs.existsSync(path.join(this.paths.all, name))) {
      return this.getNoteByFilename(name)
    }
    else {
      if (/^((\d+)[0-9a-z]*)/.test(name)) {
        return this.getNoteById(name)
      }
      else {
        return this.getNotesByLabel(name)[0]
      }
    }
  }
  getNotesByTags(tags) {
    var allNotes = this.getAllNotes()
    var notes = []
    for (var n of allNotes) {
      var noteTags = n.metadata.tags
      if(tags.every(t => noteTags.includes(t))) {
        notes.push(n)
      }
    }
    return notes
  }
  getUntaggedNotes(notes) {
    notes = notes || this.getAllNotes()
    var untaggedNotes = []
    for (var n of notes) {
      var noteTags = n.metadata.tags
      if(noteTags.length < 1) {
        untaggedNotes.push(n)
      }
    }
    return untaggedNotes
  }
  getAllNotes() {
    var listing = fs.readdirSync(this.paths.all)
    var notes = []
    for (var f of listing) {
      var note = this.getNoteByFilename(f)
      if (note) {
        notes.push(note)
      }
    }
    return notes
  }
  search(term, notes) {
    notes = notes || this.getAllNotes()
    var results = {}
    for (var n of notes) {
      var inlines = utils.tokenizeMarkdown(n.content)
      inlines = inlines.filter(l => RegExp(term, 'i').test(l.content))
      if (inlines.length > 0) {
        results[n.contentPath] = inlines
      }
    }
    return results
  }
  getAllStickers(notes) {
    var notes = notes || this.getAllNotes()
    var stickers = []
    for (var n of notes) {
      var inlines = utils.tokenizeMarkdown(n.content)
      for (var i of inlines) {
        var match = stickerRegex.exec(i.content)
        if (match) {
          var theseStickers = match[1].split(tagRegex).filter(s => s.trim().length > 0)
          stickers = stickers.concat(theseStickers)
        }
      }
    }
    return stickers
  }
  stickered(tags) {
    var notes = this.getAllNotes()
    var results = {}
    for (var n of notes) {
      var inlines = utils.tokenizeMarkdown(n.content)
      var newInlines = []
      for (var i of inlines) {
        var match = stickerRegex.exec(i.content)
        stickerRegex.lastIndex = 0
        if (match) {
          var stickers = match[1].split(tagRegex).filter(s => s.trim().length > 0)
          if (tags.every(t => stickers.includes(t))) {
            newInlines.push(i)
          }
        }
      }
      if (newInlines.length > 0) {
        results[n.contentPath] = newInlines
      }
    }
    return results
  }
  createTagPage(tag) {
    var tagPagePath = path.join(this.paths.all, `#${tag}.md`)
    var stickered = this.stickered([tag])
    var tagged = this.getNotesByTags([tag])
    var createTaggedSection = function() {
      var section = []
      if (tagged.length > 0) {
        section.push('## Tagged notes')
        for (var n of tagged) {
          section.push(`* [${n.name}](${n.filename})`)
        }
        section.push('\n')
      }
      return section.join('\n')
    }
    var createStickeredSection = function() {
      var section = []
      if (Object.keys(stickered).length > 0) {
        section.push('## Stickered fragments')
        for (var file in stickered) {
          var inlines = stickered[file]
          section.push(`### [${path.basename(file)}](${file})`)
          for (var l of inlines) {
            section.push(`* (Line ${l.line ? l.line : '?'})`)
            section.push(`  > ${l.content}`)
            section.push('\n')
          }
        }
        section.push('\n')
      }
      return section.join('\n')
    }
    var updateSection = function(section, content, sectionContent) {
      var lines = content.split('\n')
      var headerLine = lines.findIndex(l => l.startsWith(section))
      var nextHeaderLine = lines.slice(headerLine+1).findIndex(l => l.startsWith('## '))
      nextHeaderLine = nextHeaderLine > -1 ? nextHeaderLine+headerLine+1 : undefined

      var newLines = [...lines.slice(0, headerLine), sectionContent, ...(nextHeaderLine ? lines.slice(nextHeaderLine) : [])]
      var newFile = newLines.join('\n')
      return newFile
    }
    if (fs.existsSync(tagPagePath)) {
      var tagPage = fs.readFileSync(tagPagePath, 'utf8')
      var tagPageLines = tagPage.split('\n')
      if (tagPageLines.find(l => l.startsWith('## Tagged notes'))) {
        tagPage = updateSection('## Tagged notes', tagPage, createTaggedSection())
      }
      else {
        tagPage = tagPage + '\n' + createTaggedSection()
      }
      if (tagPageLines.find(l => l.startsWith('## Stickered fragments'))) {
        tagPage = updateSection('## Stickered fragments', tagPage, createStickeredSection())
      }
      else {
        tagPage = tagPage + '\n' + createStickeredSection()
      }
      fs.writeFileSync(tagPagePath, tagPage, 'utf8')
    }
    else {
      var tagPageLines = [`# \\#${tag}`]
      tagPageLines.push(createTaggedSection())
      tagPageLines.push(createStickeredSection())
      var tagPage = tagPageLines.join('\n')
      fs.writeFileSync(tagPagePath, tagPage, 'utf8')
    }
    return tagPage
  }
  createTagPages(tags) {
    tags = tags || Array.from(new Set(this.getAllTags().concat(this.getAllStickers())))
    for (var t of tags) {
      this.createTagPage(t)
    }
  }
  getTagTree(notes) {
    notes = notes || this.getAllNotes()
    var tree = {}
    var parseTag = function(tree, head, tail, note) {
      if (!tree[head]) {
        tree[head] = {
          "notes": [],
          "subtags": {}
        }
      }
      if (tail.length > 0) {
        var newHead, newTail
        [newHead, ...newTail] = tail
        parseTag(tree[head].subtags, newHead, newTail, note)
      }
      else {
        tree[head].notes.push(note)
      }
      return tree
    }
    for (var n of notes) {
      var tags = n.metadata.tags
      for (var t of tags) {
        var head, tail
        [head, ...tail] = t.split('.')
        parseTag(tree, head, tail, n)
      }
    }
    return tree
  }
  getAllTags(notes) {
    notes = notes || this.getAllNotes()
    var allTags = []
    for (var n of notes) {
      allTags = allTags.concat(n.metadata.tags)
    }
    allTags.filter(t => t)
    return Array.from(new Set(allTags))
  }
  repairSymLinks(renameFiles) {
    var thisCollection = this
    var walk = function (dir) {
      const dirents = fs.readdirSync(dir, {withFileTypes: true})
      const files = dirents.map((dirent) => {
        const res = path.resolve(dir, dirent.name)
        if (dirent.isSymbolicLink()) {
          var linkedPath = fs.readlinkSync(res)
          var match = filenameRegex.exec(path.basename(linkedPath))
          if (match && !fs.existsSync(linkedPath)) {
            fs.unlinkSync(res)
            var id = match[2]
            var note = thisCollection.getNoteById(id)
            if (note) {
              fs.symlinkSync(note.contentPath, renameFiles ? path.join(path.dirname(res), path.basename(note.contentPath)) : res)
            }
          }
        }
        else if (dirent.isDirectory()) {
          walk(res)
        }
      })
    }
    walk(this.path)
  }
  saveCollectionJson() {
    fs.writeFileSync(this.collectionJsonPath, JSON.stringify(this.collectionJson, null, ' '), 'utf8')
  }
}
class Note{
  constructor(contentPath, collection) {
    this.collection = collection
    this.contentPath = contentPath
    this.filename = path.basename(contentPath)
    var match = filenameRegex.exec(this.filename)
    this.id = match[1]
    this.label = match[3]
    this.metadataPath = path.join(path.dirname(contentPath), `.${this.id}.json`)
    this.metadata = JSON.parse(fs.readFileSync(this.metadataPath))
    this.content = fs.readFileSync(this.contentPath, 'utf8')
  }
  changeLabel(newLabel) {
    var match = filenameRegex.exec(this.filename)
    var fileEnding = match[4]
    var newContentPath = path.join(path.dirname(this.contentPath), `${this.id}.${newLabel}.${fileEnding}`)
    fs.renameSync(this.contentPath, newContentPath)
    this.contentPath = newContentPath
    this.collection.repairSymLinks()
    return newContentPath
  }
  get name() {
    return `${this.id}.${this.label}`
  }
  delete() {
    try {
      fs.unlinkSync(this.metadataPath)
      fs.unlinkSync(this.contentPath)
      return true
    }
    catch (err) {
      console.error(err)
      return false
    }
  }
  setContent(newContent) {
    this.content = newContent
    fs.writeFileSync(this.contentPath, newContent, 'utf8')
  }
  addTag(tag) {
    var tags = this.metadata.tags
    if (!tags.includes(tag)) {
      tags.push(tag)
    }
  }
  addTags(tags) {
    for (var t of tags) {
      this.addTag(t)
    }
  }
  removeTag(tag) {
    var tags = this.metadata.tags
    if (tags.includes(tag)) {
      tags.splice(tags.indexOf(tag), 1)
    }
  }
  removeTags(tags) {
    for (var t of tags) {
      this.removeTag(t)
    }
  }
  save() {
    fs.writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, ' '), 'utf8')
  }
}

class Inbox{
  constructor(collection) {
    this.collection = collection
    this.path = collection.paths.inbox
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
  Inbox: Inbox,
  Tags: Tags,
  newCollection: newCollection,
  utils: utils,
}
