#!/usr/bin/env node
const pensieve = require('./pensieve-lib')
const enquirer = require('enquirer')
const clipboard = require('copy-paste')
var yargs = require('yargs')
var colors = require('colors/safe')
const child_process = require('child_process')
const exec = child_process.exec
const fs = require('fs')
const path = require('path')

NoteCollection = pensieve.NoteCollection
Note = pensieve.Note
Inbox = pensieve.Inbox

const emojilib = require('emojilib');

function openInEditor(file, callback) {
  var editor = process.env.EDITOR || 'vim'
  var ed = child_process.spawn(editor, [file], {stdio: 'inherit'})
  ed.on('close', (code) => {
    if (callback) {
      callback(code)
    }
  })
}

function* arrIterator(arr) {
  for (i of arr) {
    yield i
  }
}

function openFileExternally(filepath) {
  var cmd
  switch (process.platform) {
    case 'darwin' : cmd = 'open'; break
    case 'win32' : cmd = 'start'; break
    case 'win64' : cmd = 'start'; break
    default : cmd = 'xdg-open'
  }
  exec(cmd + ' ' + filepath)
}

function searchForNote(collection, cb) {
  enquirer.prompt([{
    type: 'autocomplete',
    name: 'note',
    message: 'Select a note: ',
    choices: collection.allNotes.map(n => {
      return {message: n.name, name: n.id, value: n}
    }),
    suggest: async (input, choices) => {
      var result = collection.fuzzySearchForNote(input)
      var list = []
      if (result && result.length > 0) {
        for (var n of result) {
          list.push({message: n.item.name, name: n.item.name, value: n.item})
        }
      }
      return list
    }
  }]).then(function(answer) {
    cb(answer.note)
  })
}

yargs.command({
  command: 'open',
  describe: 'Open a note in default Markdown app',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    searchForNote(collection, n => openFileExternally(n.contentPath))
  }
})

yargs.command({
  command: 'collection',
  describe: 'Manage or create a collection',
  builder: {
    new: {
      describe: 'Create new note collection',
    },
    paths: {
      describe: 'Change paths location',
      type: 'array',
    },
  },
  handler: function(argv) {
    if (argv.new) {
      var sampleCJ = pensieve.utils.createNewCollectionJson()
      var options = {}
      enquirer
      .prompt([
        {
          type: 'input',
          name: 'name',
          message: 'What should the collection be called?',
          default: sampleCJ.name,
        },
      ])
      .then(answers1 => {
        enquirer
        .prompt([
          {
            type: 'input',
            name: 'dir',
            message: 'Where should the collection be located?',
            default: path.join(process.cwd(), answers1.name),
          },
          {
            type: 'input',
            name: 'allFolder',
            message: 'Path of All folder?',
            default: sampleCJ.paths.all,
          },
          {
            type: 'input',
            name: 'inboxFolder',
            message: 'Path of Inbox folder?',
            default: sampleCJ.paths.inbox,
          },
          {
            type: 'input',
            name: 'archiveFolder',
            message: 'Path of Archive folder?',
            default: sampleCJ.paths.archive,
          },
        ])
        .then(answers2 => {
          try {
            pensieve.newCollection(answers2.dir, {
              name: answers1.name,
              paths: {
                ...sampleCJ.paths,
                all: answers2.allFolder,
                inbox: answers2.inboxFolder,
                archive: answers2.archiveFolder,
              }
            })
          }
          catch (e) {
            errorHandler(e)
          }
        })
      })
    }
    if (argv.paths) {
      var key = argv.paths[0]
      var newPath = argv.paths[1]
      try {
        var collection = new NoteCollection('')
      }
      catch (e) {
        errorHandler(e)
      }
      var paths = collection.paths
      collection.collectionJson.paths[key] = newPath
      collection.saveCollectionJson()
    }
  }
})

yargs.command({
  command: 'new [label]',
  describe: 'Add new note',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    if (argv.label) {
      var note = collection.newNote(argv.label)
    }
    else {
      var note = collection.newNote()
    }
    openInEditor(note.contentPath)
  }
})

yargs.command({
  command: 'edit <note>',
  describe: 'Edit a note',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    var note = collection.resolveToNote(argv.note)
    if (note) {
      openInEditor(note.contentPath)
    }
  }
})

yargs.command({
  command: 'rm <notes..>',
  describe: 'Remove note(s)',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    var returnCode = 0
    enquirer
      .prompt([
        {
          name: "remove",
          type: "confirm",
          message: `Are you sure you want to remove ${argv.notes.length} note${argv.notes.length > 1 ? 's' : ''}?`,
        },
      ])
      .then((answer) => {
        if (answer.remove) {
          for (var n of argv.notes) {
            note = collection.resolveToNote(n)
            if (note) {
              note.delete()
            }
            else {
              console.error(`No note such note: ${n}`)
              returnCode = 1
            }
          }
          process.exit(returnCode)
        }
      })
  }
})

yargs.command({
  command: 'label <note> <label>',
  describe: 'Change the label of a note',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    note = collection.resolveToNote(argv.note)
    if (note) {
      note.changeLabel(argv.label)
    }
  }
})

yargs.command({
  command: 'category <note> <category>',
  describe: 'Put a note in a category',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    note = collection.resolveToNote(argv.note)
    if (note) {
      collection.categorize(note, argv.category)
    }
  }
})

yargs.command({
  command: 'tag <notes..>',
  describe: 'Modify the tags of notes',
  builder: {
    add: {
      describe: 'Add a tag',
      type: 'array',
    },
    remove: {
      describe: 'Remove a tag',
      alias: 'rm',
      type: 'array',
    },
    has: {
      describe: 'Check for a tag',
      type: 'string',
    },
    edit: {
      describe: 'Edit the tags in an editor',
      type: 'boolean',
    },
    select: {
      describe: 'Select tags',
      type: 'boolean',
    },
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    if (argv.add) {
      for (var n of argv.notes) {
        var note = collection.resolveToNote(n)
        for (var t of argv.add) {
          note.addTag(t)
        }
        note.save()
      }
    }
    if (argv.remove) {
      for (var n of argv.notes) {
        var note = collection.resolveToNote(n)
        for (var t of argv.remove) {
          note.removeTag(t)
        }
        note.save()
      }
    }
    if (argv.has) {
      if (argv.notes.length > 1) {
        console.error('Error: --has can only proceed one note at a time')
        process.exit(1)
      }
      else {
        var note = collection.resolveToNote(argv.notes[0])
        if (note.metadata.tags.includes(argv.has)) {
          process.exit(0)
        }
        else {
          process.exit(1)
        }
      }
    }
    if (argv.edit) {
      var it = arrIterator(argv.notes)
      var editTags = function(n) {
        var note = collection.resolveToNote(n)
        var tagString = note.metadata.tags.join('\n')
        fs.writeFileSync(`/tmp/pensieveTags.${note.getName()}`, tagString, 'utf8')
        openInEditor(`/tmp/pensieveTags.${note.getName()}`, c => {
          tagString = fs.readFileSync(`/tmp/pensieveTags.${note.getName()}`, 'utf8')
          note.metadata.tags = tagString.split('\n').filter(t => t != '')
          note.save()
          var result = it.next()
          if (!result.done && result.value) {
            editTags(result.value)
          }
        })
      }
      var result = it.next()
      if (!result.done && result.value) {
        editTags(result.value)
      }
    }
    if (argv.select) {
      var it = arrIterator(argv.notes)
      var createSelector = function(n) {
        var note = collection.resolveToNote(n)
        var tags = note.metadata.tags
        var choices = [{message:` = ${note.getName()} = `, role: 'separator'}]
        var tree = collection.getTagTree()
        var tagMetadata = new pensieve.Tags(collection)
        var convertTree = function(tree, level, head) {
          for (var t of Object.keys(tree)) {
            var newHead = head + (head=='' ? '' : '.') + t
            var currentTagMetadata = tagMetadata.getTag(newHead)
            choices.push({
              message: '  '.repeat(level)+colors.grey.bold(`${(currentTagMetadata && currentTagMetadata.icon) ? currentTagMetadata.icon : '#'} `)+t,
              name: newHead,
              value: newHead,
              enabled: tags.includes(newHead)
            })
            convertTree(tree[t].subtags, level+1, newHead)
          }
        }
        convertTree(tree, 0, '')
        enquirer
        .prompt([
          {
            type: 'multiselect',
            message: 'Select tags',
            name: 'newTags',
            pageSize: 20,
            initial: tags,
            choices: choices
          }])
          .then((answers) => {
            note.metadata.tags = answers.newTags
            note.save()
            var result = it.next()
            if (!result.done && result.value) {
              createSelector(result.value)
            }
          })
        }
        var result = it.next()
        if (!result.done && result.value) {
          createSelector(result.value)
        }
    }
  }
})

yargs.command({
  command: 'tagged [tags..]',
  describe: 'Return a list of notes tagged with all provided tags',
  builder: {
    "edit": {
      describe: 'Edit which files are tagged',
      type: 'boolean',
    },
    "view": {
      describe: 'Show the content of the tagged notes',
      type: 'boolean',
    },
    "tree": {
      describe: 'Show the tag tree',
      type: 'boolean',
    },
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    if (argv.edit) {
      var notes = collection.getNotesByTags(argv.tags)
      var files = notes.map(n => n.filename).join('\n')
      fs.writeFileSync('/tmp/pensieveTagFiles', files, 'utf8')
      openInEditor('/tmp/pensieveTagFiles', c => {
        tagString = fs.readFileSync('/tmp/pensieveTagFiles', 'utf8')
        var newFiles = tagString.split('\n').filter(t => t != '')
        var newNotes = []
        for (var f of newFiles) {
          var note = collection.resolveToNote(f)
          note && newNotes.push(note)
        }
        var oldIds = notes.map(n => n.id)
        var newIds = newNotes.map(n => n.id)
        var toRemove = oldIds.filter(x => newIds.indexOf(x) == -1)
        var toAdd = newIds.filter(x => oldIds.indexOf(x) == -1)
        toRemove.forEach(id => {
          var note = collection.resolveToNote(id)
          if (note) {
            note.removeTags(argv.tags)
            note.save()
          }
        })
        toAdd.forEach(id => {
          var note = collection.resolveToNote(id)
          if (note) {
            note.addTags(argv.tags)
            note.save()
          }
        })
      })
    }
    else if (argv.tree) {
      var tree = collection.getTagTree()
      var tagMetadata = new pensieve.Tags(collection)
      var printTree = function(tree, level, head) {
        for (var t of Object.keys(tree)) {
          var newHead = head + (head=='' ? '' : '.') + t
          var currentTagMetadata = tagMetadata.getTag(newHead)
          console.log('  '.repeat(level)+colors.grey.bold(`${(currentTagMetadata && currentTagMetadata.icon) ? currentTagMetadata.icon : '#'} `)+colors.green(t))
          printTree(tree[t].subtags, level+1, newHead)
          for (var n of tree[t].notes) {
            console.log('  '.repeat(level+1)+n.getName())
          }
        }
      }
      printTree(tree, 0, '')
    }
    else {
      var notes = collection.getNotesByTags(argv.tags)
      for (var n of notes) {
        if (argv.view) {
          console.log(colors.red(n.contentPath))
          console.log(n.content)
        }
        else {
          console.log(n.contentPath)
        }
      }
    }
  }
})
yargs.command({
  command: 'untagged',
  describe: 'Return a list of notes tagged with all provided tags',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    var notes = collection.getUntaggedNotes()
    for (var n of notes) {
      console.log(n.contentPath)
    }
  }
})

yargs.command({
  command: 'tags <tag>',
  describe: 'Organize tag metadata',
  builder: {
    "icon": {
      describe: 'Change icon',
    }
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    var tagMetadata = new pensieve.Tags(collection)
    if (argv.icon) {
      const emoj = input => {
        input = input || ''
        const regexSource = input.toLowerCase().split(/\s/g)
        .map(v => v.replace(/\W/g, ''))
        .filter(v => v.length > 0)
        .map(v => v.length < 4 ? `^${v}$` : v)
        .join('|');

        if (regexSource.length === 0) {
          return [];
        }

        const regex = new RegExp(regexSource);
        const emoji = [];

        for (const [name, data] of Object.entries(emojilib.lib)) {
          let matches = regex.test(name);
          for (const keyword of data.keywords) {
            matches = matches || regex.test(keyword);
          }

          if (matches) {
            emoji.push(data.char);
          }
        }

        return emoji;
      }

      enquirer.prompt([{
        type: 'autocomplete',
        name: 'icon',
        message: 'Select an icon for tag: ',
        choices: [],
        suggest: async (input, choices) => {
          return emoj(input).map(e => {
            return {message: e, name: e, value: e}
          })
        }
      }]).then(function(answers) {
        tagMetadata.updateTag(argv.tag, {icon: answers.icon})
        tagMetadata.save()
      })
    }
  }
})

yargs.command({
  command: 'search <term>',
  describe: 'Search within notes',
  builder: {
    "notes-from-stdin": {
      describe: 'Receive tags froms stdin',
      type: 'boolean',
    }
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    if (argv['notes-from-stdin']) {
      var files = fs.readFileSync(0, 'utf-8').split('\n')
      var notes = files.map(f => collection.getNoteByFilename(f)).filter(n => n != undefined)
    }
    var results = collection.search(argv.term, notes)
    if (Object.keys(results).length < 1) {
      process.exit(1)
    }
    else {
      for (file in results) {
        var inlines = results[file]
        console.log(colors.red(file))
        for (var l of inlines) {
          process.stdout.write(colors.green(`(Line ${l.line ? l.line : '?'}): `))
          console.log(l.content)
        }
      }
    }
  }
})

yargs.command({
  command: 'stickered <tags..>',
  describe: 'Show fragments stickered with tags',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    var results = collection.stickered(argv.tags)
    if (Object.keys(results).length < 1) {
      process.exit(1)
    }
    else {
      for (file in results) {
        var inlines = results[file]
        console.log(colors.red(file))
        for (var l of inlines) {
          process.stdout.write(colors.green(`(Line ${l.line ? l.line : '?'}): `))
          console.log(l.content)
        }
      }
    }
  }
})

yargs.command({
  command: 'inbox [text]',
  describe: 'Send something to the inbox',
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    var inbox = new Inbox(collection)
    if (argv.text) {
      inbox.sendText(argv.text)
    }
    else if (argv.view) {
      var listing = fs.readdirSync(inbox.path)
      listing = listing.filter(f => /\.(md|txt)$/.test(f))
      for (f of listing) {
        var content = fs.readFileSync(path.join(inbox.path, f), 'utf-8')
        console.log(colors.red(f))
        console.log(content)
      }
    }
    else {
      var text = fs.readFileSync(0, 'utf-8')
      text && inbox.sendText(text)
    }
  }
})

yargs.completion('generate-completion')

function errorHandler(err) {
  var logger = function(message) {
    console.error(colors.red('Error: '+message))
  }
  if (err.name == 'noCollectionJson') {
    logger(err.message)
    process.exit(1)
  }
  else if (err.name == 'existantCollectionJson') {
    logger(err.message)
    process.exit(1)
  }
}

yargs.parse()
