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
  var len = arr.length
  var i = 0
  var dir = 1
  while (i < len) {
    dir = yield arr[i]
    dir = dir || 1
    i = i + dir
    if (i < 0) {
      i = len + i
    }
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

function manageInbox(inbox) {
  var listing = fs.readdirSync(inbox.path)
  listing = listing.filter(f => /\.(md|txt)$/.test(f))
  var manageLoop = function() {
    var it = arrIterator(listing)
    var selectedFiles = []
    var nextFile = function(dir) {
      var result = it.next(dir)
      if (!result.done && result.value) {
        manageFile(result.value)
      }
      else {
        manageSelectedFiles(selectedFiles)
      }
    }
    var manageFile = function(f) {
      var fullPath = path.join(inbox.path, f)
      var content = fs.readFileSync(fullPath, 'utf-8')
      process.stdout.write(colors.green(`(${listing.indexOf(f)+1}/${listing.length}): `))
      console.log(colors.red(f))
      console.log(content)
      enquirer.prompt({
        type: 'input',
        name: 'action',
        message: '[d]elete [e]dit [i]nsert [m]ove [s]elect | [n]ext [p]revious | [q]uit',
        validate: (value) => {
          if (!['d', 't', 'e', 'i', 'm', 's', 'n', 'p', 'q'].includes(value.trim().toLowerCase())) {
            return false
          }
          return true
        },
      })
      .then((answer) => {
        var action = answer.action.trim()
        if (action == 'd') {
          enquirer
          .prompt([
            {
              name: "remove",
              type: "confirm",
              message: `Are you sure you want to remove ${f}?`,
            },
          ])
          .then((answer) => {
            if (answer.remove) {
              fs.unlinkSync(fullPath)
            }
            nextFile()
          })
        }
        else if (action == 'm') {
          var moveFromInboxPath = inbox.collection.paths.moveFromInbox
          if (fs.existsSync(moveFromInboxPath)) {
            fs.copyFile(fullPath, path.join(moveFromInboxPath, f), function (err) {
              if (err) {
                throw err
              }
              else {
                fs.unlinkSync(fullPath)
              }
              nextFile()
            })
          }
        }
        else if (action == 'e') {
          openInEditor(fullPath,(code) =>{
            nextFile()
          })
        }
        else if (action == 'i') {
          searchForNote(inbox.collection, (note) => {
            insertInNote(note, content, (newContent) => {
              enquirer
              .prompt([
                {
                  name: "remove",
                  type: "confirm",
                  message: `Now delete ${f}?`,
                },
              ])
              .then((answer) => {
                if (answer.remove) {
                  fs.unlinkSync(fullPath)
                }
                nextFile()
              })
              .catch(console.error)
            })
          })
        }
        else if (action == 's') {
          selectedFiles.push({
            file: f,
            fullPath: fullPath,
            content: content,
          })
          nextFile()
        }
        else if (action == 'n') {
          nextFile()
        }
        else if (action == 'p') {
          nextFile(-1)
        }
        else if (action == 'q') {
          return
        }
      })
    }
    nextFile()
  }
  var manageSelectedFiles = function(selection) {
    var mergeTogether = function(selection) {
      var mergedContent = ''
      for (var s of selection) {
        mergedContent = mergedContent + (mergedContent ? '\n' : '') + s.file + '\n'
        mergedContent = mergedContent + s.content.trim() + '\n'
      }
      return mergedContent
    }
    var removeSelectedFiles = function(selection) {
      enquirer
      .prompt([
        {
          name: "remove",
          type: "confirm",
          message: `Now delete ${selection.map(s => s.file).join(', ')}?`,
        },
      ])
      .then((answer) => {
        if (answer.remove) {
          for (var s of selection) {
            fs.unlinkSync(s.fullPath)
          }
        }
      })
      .catch(console.error)
    }
    console.log('Selected files: ')
    for (var s of selection) {
      var {file, content} = s
      console.log(colors.red(file))
      console.log(content.length < 60 ? content : content.slice(0, 60)+'...')
    }
    enquirer.prompt({
      type: 'input',
      name: 'action',
      message: '[m]erge into new note, [c]ombine in inbox | [a]bort',
      validate: (value) => {
        if (!['m', 'c', 'a'].includes(value.trim().toLowerCase())) {
          return false
        }
        return true
      },
    })
    .then((answer) => {
      var action = answer.action
      if (action == 'a') {
        return
      }
      else if (action == 'c') {
        var mergedContent = mergeTogether(selection)
        enquirer.prompt({
          type: 'input',
          name: 'name',
          message: 'Name of new fleeting note inbox?',
        })
        .then((answer) => {
          var filename = answer.name.endsWith('.md') ? answer.name : answer.name + '.md'
          var filepath = inbox.sendText(mergedContent, filename)
          openInEditor(filepath, (code) => {
            removeSelectedFiles(selection)
          })
        })
        .catch(console.error)
      }
      else if (action == 'm') {
        var mergedContent = mergeTogether(selection)
        newNoteWizard(inbox.collection, (note) => {
          note.setContent(mergedContent)
          openInEditor(note.contentPath, (code) => {
            removeSelectedFiles(selection)
          })
        })
      }
    })
    .catch(console.error)
  }
  manageLoop()
}

function insertInNote(note, insertion, cb) {
  var content = note.content
  var lines = content.split(/\n/)

  enquirer.prompt({
    type: 'select',
    name: 'line',
    message: 'Where to append line?',
    hint: `${insertion.length < 30 ? insertion : insertion.slice(0, 30) + '...'} (${insertion.length} c)`,
    limit: 10,
    // index: 4,
    choices: [{role: 'separator', message: `== ${note.name} ==`},
    ...lines.map((l, i) => ({
      name: i+1,
      message: l ? l : ' '
    }))]
  })
  .then(function(answer = []) {
    var line = answer.line
    console.log(`Insert in line ${line} of ${note.name}:`)
    console.log(insertion)
    enquirer.prompt({
      type: 'input',
      name: 'action',
      message: '[r]aw [b]ullet [e]dit | [a]bort',
      validate: (value) => {
        if (!['r', 'b', 'e', 'a'].includes(value.trim().toLowerCase())) {
          return false
        }
        return true
      },
    })
    .then((answer) => {
      // console.log(answer)
      var action = answer.action
      var insertLine = function(ins) {
        lines.splice(line, 0, ins)
        return lines.join('\n')
      }
      if (action == 'a') {
        cb()
        return
      }
      else if (action=='e') {
        var editPath = '/tmp/pensieveInsertion.md'
        fs.writeFileSync(editPath, insertion, 'utf8')
        openInEditor(editPath,(code) =>{
          var insertion = fs.readFileSync(editPath, 'utf8')
          note.setContent(insertLine(insertion))
          cb()
        })
      }
      else if (action = 'b') {
        insertion = insertion.split('\n').map(l => l ? `* ${l}` : '').join('\n')
        note.setContent(insertLine(insertion))
        cb()
      }
      else if (action == 'r') {
        note.setContent(insertLine(insertion))
        cb()
      }
    })
  })
  .catch(console.error)
}

yargs.command({
  command: 'open',
  describe: 'Open a note in default Markdown app',
  handler: function(argv) {
    try {
      var collection = new NoteCollection(process.cwd())
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
      var form = new enquirer.Form({
        name: 'newCollection',
        message: 'Create a new collection',
        choices: [
          {
            name: 'name',
            message: 'Name',
            initial: sampleCJ.name,
          },
          {
            name: 'dir',
            message: 'Location',
            onChoice(state, choice, i) {
              let { name } = this.values
              choice.initial = path.join(process.cwd(), name||'')
            }
          },
          {
            name: 'allFolder',
            message: 'Path of All folder',
            initial: sampleCJ.paths.all,
          },
          {
            name: 'inboxFolder',
            message: 'Path of Inbox folder',
            initial: sampleCJ.paths.inbox,
          },
          {
            name: 'archiveFolder',
            message: 'Path of Archive folder',
            initial: sampleCJ.paths.archive,
          },
        ]
      })
      form.run().then(answers => {
        try {
          pensieve.newCollection(answers.dir, {
            name: answers.name,
            paths: {
              ...sampleCJ.paths,
              all: answers.allFolder,
              inbox: answers.inboxFolder,
              archive: answers.archiveFolder,
            }
          })
        }
          catch (e) {
            errorHandler(e)
          }
      })
    }
    if (argv.paths) {
      var key = argv.paths[0]
      var newPath = argv.paths[1]
      try {
        var collection = new NoteCollection(process.cwd())
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

function newNoteWizard(collection, cb) {
  var prospectiveId = collection.getHighestId() + 1
  var form = new enquirer.Form({
    name: 'newNote',
    message: 'Create a new note',
    choices: [
      {
        name: 'id',
        message: 'Prospective Id',
        initial: prospectiveId,
        disabled: true,
        hint: '',
      },
      {
        name: 'label',
        message: 'Label',
        initial: pensieve.utils.createLabelFromId(prospectiveId),
      },
      {
        name: 'tags',
        message: 'Tags',
      },
      {
        name: 'category',
        message: 'Category',
      },
    ]
  })
  form.run().then(answers => {
    var note = collection.newNote(answers.label)
    note.addTags(answers.tags.split(/\s+/).filter(x => x != ''))
    note.save()
    if (answers.category) {
      collection.categorize(note, answers.category)
    }
    if(cb) {
      cb(note)
    }
  })
}

yargs.command({
  command: 'new [label]',
  describe: 'Add new note',
  builder: {
    wizard: {
      describe: 'Specify label, tags and more',
    },
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection(process.cwd())
    }
    catch (e) {
      errorHandler(e)
    }
    if (argv.wizard) {
      newNoteWizard(collection)
    }
    else {
      if (argv.label) {
        var note = collection.newNote(argv.label)
      }
      else {
        var note = collection.newNote()
      }
      openInEditor(note.contentPath)
    }
  }
})

yargs.command({
  command: 'edit <note>',
  describe: 'Edit a note',
  handler: function(argv) {
    try {
      var collection = new NoteCollection(process.cwd())
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
      var collection = new NoteCollection(process.cwd())
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
      var collection = new NoteCollection(process.cwd())
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
  command: 'category [note] [category]',
  describe: 'Put a note in a category',
  builder: {
    auto: {
      describe: 'Automatically categorize notes',
    },
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection(process.cwd())
    }
    catch (e) {
      errorHandler(e)
    }
    if (argv.auto) {
      collection.autoCategorize(collection.allNotes)
    }
    else {
      note = collection.resolveToNote(argv.note)
      if (note) {
        collection.categorize(note, argv.category)
      }
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
      var collection = new NoteCollection(process.cwd())
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
        fs.writeFileSync(`/tmp/pensieveTags.${note.name}`, tagString, 'utf8')
        openInEditor(`/tmp/pensieveTags.${note.name}`, c => {
          tagString = fs.readFileSync(`/tmp/pensieveTags.${note.name}`, 'utf8')
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
        var choices = [{message:` = ${note.name} = `, role: 'separator'}]
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
            message: `Select tags for ${note.name}`,
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
      var collection = new NoteCollection(process.cwd())
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
            console.log('  '.repeat(level+1)+n.name)
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
      var collection = new NoteCollection(process.cwd())
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
      var collection = new NoteCollection(process.cwd())
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
        message: `Select an icon for tag #${argv.tag}: `,
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
      var collection = new NoteCollection(process.cwd())
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
      var collection = new NoteCollection(process.cwd())
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
  builder: {
    "text": {
      describe: 'Send string to inbox',
      type: 'string',
    },
    "clipboard": {
      describe: 'Send clipboard content to inbox',
      type: 'boolean',
    },
    "view": {
      describe: 'View the inbox',
      type: 'boolean',
    },
    "manage": {
      describe: 'Manage the inbox',
      type: 'boolean',
    },
  },
  handler: function(argv) {
    try {
      var collection = new NoteCollection(process.cwd())
    }
    catch (e) {
      errorHandler(e)
    }
    var inbox = new Inbox(collection)
    if (argv.text) {
      inbox.sendText(argv.text)
    }
    else if (argv.clipboard) {
      var clipboardContent = clipboard.paste()
      if (clipboardContent) {
        inbox.sendText(clipboardContent)
      }
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
    else if (argv.manage) {
      manageInbox(inbox)
    }
    else if (!process.stdin.isTTY) {
      var text = fs.readFileSync(0, 'utf-8')
      text && inbox.sendText(text)
    }
    else {
      fs.writeFileSync('/tmp/pensieveSendToInbox.md', '', 'utf8')
      openInEditor('/tmp/pensieveSendToInbox.md', c => {
        var text = fs.readFileSync('/tmp/pensieveSendToInbox.md', 'utf8')
        text && inbox.sendText(text)
      })
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
