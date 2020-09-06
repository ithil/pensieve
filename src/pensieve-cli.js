#!/usr/bin/env node
const pensieve = require('./pensieve-lib')
const inquirer = require('inquirer')
const clipboard = require('copy-paste')
var yargs = require('yargs')
var colors = require('colors/safe')
const child_process = require('child_process')
const fs = require('fs')
const path = require('path')

NoteCollection = pensieve.NoteCollection
Note = pensieve.Note
Inbox = pensieve.Inbox

function openInEditor(file, callback) {
  var editor = process.env.EDITOR || 'vim'
  var ed = child_process.spawn(editor, [file], {stdio: 'inherit'})
  ed.on('close', (code) => {
    if (callback) {
      callback(code)
    }
  })
}
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
      inquirer
      .prompt([
        {
          name: 'name',
          message: 'What should the collection be called?',
          default: sampleCJ.name,
        },
      ])
      .then(answers1 => {
        inquirer
        .prompt([
          {
            name: 'dir',
            message: 'Where should the collection be located?',
            default: path.join(process.cwd(), answers1.name),
          },
          {
            name: 'allFolder',
            message: 'Path of All folder?',
            default: sampleCJ.paths.all,
          },
          {
            name: 'inboxFolder',
            message: 'Path of Inbox folder?',
            default: sampleCJ.paths.inbox,
          },
          {
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
      var key = argv[0]
      var newPath = argv[1]
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
    inquirer
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
      if (argv.notes.length > 1) {
        console.error('Error: --edit can only proceed one note at a time')
        process.exit(1)
      }
      var note = collection.resolveToNote(argv.notes[0])
      var tagString = note.metadata.tags.join('\n')
      fs.writeFileSync('/tmp/pensieveTags', tagString, 'utf8')
      openInEditor('/tmp/pensieveTags', c => {
        tagString = fs.readFileSync('/tmp/pensieveTags', 'utf8')
        note.metadata.tags = tagString.split('\n').filter(t => t != '')
        note.save()
      })
    }
  }
})

yargs.command({
  command: 'tagged <tags..>',
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
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection('')
    }
    catch (e) {
      errorHandler(e)
    }
    var notes = collection.getNotesByTags(argv.tags)
    if (argv.edit) {
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
    else {
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
