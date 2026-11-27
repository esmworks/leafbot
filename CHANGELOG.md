# Changelog

All notable changes to Leaf Bot (called Yumak Bot before 0.7.0) are listed here. Versions follow [Semantic Versioning](https://semver.org/). While the
version is 0.x, a minor release may change the data format or the API; the server migrates its database on start.

## Unreleased

### Added

- A server can be opened from the web at www.leafbot.app/bots without opening a port or having an address of its
  own. Its owner signs in to a Leaf Bot account on the website, takes an install code there and pastes it under
  Settings → Connection → Leaf Bot account. The server then keeps a connection out to Leaf Bot's relay, and people
  in the account sign in at /bots, pick the server and use the same app as on the server itself; requests, live
  updates and files go over an encrypted WebRTC channel straight to the server (through a TURN relay when the two
  cannot reach each other), so the website never sees what passes. Before, reaching a server from elsewhere needed
  a public address with HTTPS, which a server behind a home router or a company firewall could not have. Each
  browser proves itself with a key of its own and a short-lived ticket from the account, and the server checks both;
  linking and unlinking are refused over the tunnel, so a connection cannot move the server to another account. A
  connection that drops (the server restarting, the network) is opened again by itself for up to five minutes, with
  the app left as it was; a refusal, such as access taken away, is shown at once. On
  the web, pages bots make and connected apps' views are not shown and PDFs are downloaded, since their scripts
  would run on the website's address. The direct address keeps working as before for the phone apps, webhooks and
  shared pages. `LEAFBOT_ACCOUNT_URL`, `LEAFBOT_RELAY_URL` and `LEAFBOT_WEB_HOST` point a server at other hosts.
- The owner signs in to their Leaf Bot account in the app itself, before anything else, when their server is not
  linked to one: an emailed code, then a first and last name if the account has none. The server links itself to
  the account on the way, so it is reachable from the phone and the web without fetching an install code by hand.
  It is asked once: whether to ask is read from the server's own state, so a linked app opens while the account
  service cannot be reached. The account's name is kept with the account and carried in its tickets; the server
  calls the person by it, a person reaching a server through their account is no longer nameless there, and the
  first-run questions start after the name when it is already known. An owner signed in this way is not asked to
  make a username and password for the server.
- `leafbot login` signs a server with no screen (a VPS, a home server) in to its owner's Leaf Bot account the same
  way, in the terminal: the email, the code mailed to it, and the name when the account has none. Before, such a
  server could only be linked with an install code fetched from the website and pasted in the app. On a server set
  up with `docker/install.sh` it asks in the running server's container and restarts the server afterwards;
  elsewhere `node dist/index.mjs login` runs on the server's data folder (`LEAFBOT_DATA_DIR`), which works before
  the first start and, with the embedded database, only while the server is stopped.
- The embedded database's folder is locked by the process that opens it (`db.lock` in the data folder). A second
  server or `leafbot login` on the same folder is refused instead of writing the same files, which corrupts the
  database; a server starting while another is still shutting down waits for it.
- `docker/firewall.sh` takes `HOST_PORTS` (such as `udp/3478 tcp/3478 udp/49152:65535`), ports on the host the
  containers may open connections to. A server on the same machine as its TURN server needs it: the firewall shuts
  the containers out of the host, so the server could not reach TURN and browsers could not reach the server.
- A Chrome extension (`extension/`, early): a side panel to talk to the bots beside any page. With sharing on, a
  message written in the panel lets the bot list the open tabs and read the text of one, so a question about the page
  in front needs no copying. Only turns started from the panel reach Chrome, and only the Chrome of that panel; the first read in each turn asks on a
  card at every permission level, and each new site needs the person's own yes in Chrome. The server lets in
  requests from the extension's own id only.
- A coding agent bot's effort is now set as the agent's own thinking level, or the nearest level it has, when
  the agent offers one. The effort field shows for these bots too; an agent without such a setting ignores it.
- Routines can have no schedule ("No schedule" under When). Such a routine runs only when one of its events
  comes (a webhook call, an email, a table row, a Slack reaction, the server starting) or when run by hand.
  Before, a routine meant only to answer events needed a schedule it did not want, and ran on it too. Page
  watching, an app's check and a condition happen before a scheduled run, so they are refused on one with no
  schedule. Bots can set one up with routine_create. Older phone apps show such a routine without its schedule.
- Dictation language under Settings → General: the app's language (as before), detect automatically, or a set
  language. People often write to bots in another language than the interface's, and dictation held to the
  interface language wrote their speech out wrong. Kept on each device.
- An "only unread" button beside the sidebar search lists just the bots with replies not seen yet or waiting on
  you, so a long list can be caught up on. Dragging bots is off while it hides part of the list.
- When a bot sets up a routine, those who see the conversation get a notice with Open, which goes straight to the
  routine.
- A server's own OAuth app can be entered on its page after it was added (Use my own OAuth app), which then
  signs in again. Before, a server that turned out to take no registrations on its own had to be removed and
  added again to get one.
- Pictures in a conversation are shown from a small copy (512 pixels on the longest side) and the full file is
  fetched only when one is opened, so a phone on a joined server no longer downloads every photo at full size.
- A bot can open a site that asks for its own browser sign-in box (HTTP Basic). When a page answers with that box,
  the browser tool tells the bot the site wants its own sign-in, and `browser_login` with no fields signs in with the
  password saved for that site in the vault. The password never reaches the bot or the conversation, and the page
  reloads signed in. Before, the bot only saw an error page and had no way past it.
- Advisor model for Claude bots: under Providers → Claude, a stronger Claude model (Fable, Opus or Sonnet) can be
  chosen that Claude bots may ask for advice when they are stuck, before a large step and before they call their
  work done. The bot decides when to ask; the advisor sees the whole conversation, answers only the bot, and its
  tokens are billed at its own model's rates and count toward spending. It applies only when it is at least as
  capable as the bot's model, a bot already on that model gets none, and the backup model gets none. It starts off.
  On a Claude subscription, Fable as the advisor may need extra usage turned on.
- Advisor model for bots on other providers: under Providers → Defaults, a model of any connected provider can be
  chosen; bots on other providers then get a tool to ask it for advice, up to three times a turn. It reads the bot's
  instructions, the summary of the earlier conversation and the recent conversation with its tool results, answers
  only the bot, and its cost counts toward the turn. It asks for no approval, helper agents and the backup model do
  without it, and a bot already on that model gets none. An advisor that cannot answer leaves the bot to go on by
  itself. It starts off.
- Sharing a table with another bot: from the table's window, someone who may change both bots lets another bot
  read the table, or read and write its rows. The other bot finds it among its tables as "Owner / Name"; its own
  table of the same name comes first. The columns and the table stay with their bot, so the other bot cannot add
  columns or delete the table. Taking the share back holds from the bot's next step. A guest's or WhatsApp
  contact's turn does not reach shared tables, and someone who talks only to the other bot still cannot open the
  table on the web. Rows the other bot writes do not start the owner's table routines, as no bot's writes do. Shares
  are set on the web, not on the phone.
- Table views: a table can be shown as a grid, a board, a gallery of cards or a list, grouped by one of its
  columns. On a board each value of the column (a status, a stage) is a lane, and dragging a card to another lane
  changes that cell, as editing it would; every field on a card can be edited in place too. The view is kept with
  the table, so everyone who opens it sees the same; changing it needs the same right as editing the table. A bot can
  choose the view when it sets up the table. On the phone rows stay cards, grouped the same way.
- A bot that goes round in circles on a screen (its own desktop or your computer) is stopped: after 40 screens in a
  row that show nothing it has not seen in its last few, it may not look at or touch the screen again in that turn
  and is told to say what it was trying, what it tried and what blocks it. Small changes such as a blinking cursor
  or a clock do not count as new; a slowly filling progress bar does in time. Commands on the bot's own desktop
  still run. The count goes by screens, not time, so a bot waiting on your answer is not stopped for it.
- Common knowledge: notes every bot on the server reads, such as the company address or a team rule. Those who
  look after the server write them on the memory screen and they apply at once; everyone else sees them there. A bot
  only proposes adding, changing or deleting one, and the proposal waits under "Waiting for approval" for someone who
  looks after the server, saying when the bot had read outside text. They have their own room in the prompt, so they
  neither crowd out a bot's own notes nor get crowded out, at most 100 notes; they do not reach a guest's turn or a
  WhatsApp contact. On the phone they show in the memory settings; they are added on the web.
- A note a bot writes or changes while outside text (a page, a mail, a command's output) is in its conversation is
  marked unverified. It is still written straight away and still reaches bots, but marked as outside data, so a
  page cannot turn its words into a fact bots trust. The background review and the weekly tidy-up mark what they
  write from such text too. The memory screen shows the mark with a Verify button; your own edit clears it as well.
  Notes written before this update are not marked. The mark is advice to the model, not a gate: an unverified note
  can still shape what a bot does.
- A tool result too long for the conversation is kept whole for the rest of it, instead of only cut: the bot sees
  the start (for a shell command, the start and the end) and reads the rest page by page with `ReadResult`. Pages
  read back from outside text are marked as outside text again. Kept in the server's memory only, ten results per
  conversation; a restart forgets them. With the Claude engine, Claude Code handles long results itself.
- Settings has a Computer use section, shown where the bots could use a computer: it says whether macOS allows
  Screen Recording and Accessibility, and each one's button opens System Settings at its list. macOS asks its own
  question only once, so after a no this was the way left, and the bot form's button now leads here. A Windows
  computer is said to need neither; a computer connected from afar is named, and its buttons open the settings there.
- Bots can run commands on your own computer through the desktop app, when you turn on "Bots may run commands"
  beside "Bots may use this computer" in the Leaf Bot icon's menu (off until you do; with the server elsewhere). The
  computer resolves the folder first and each command asks on a card at every permission level; "always allow"
  keeps that command in that folder for you alone, never full access, and a shared bot still asks other people on
  their computers. Commands that name a place where keys are kept (`.ssh`, `.aws`, `.env` and the like) also ask on
  the computer itself every time and get no "always allow"; this is a check of the command's text, so a script that
  reaches such a place by itself is not caught. At most four run at once, each for at most two hours. A command that
  outlasts its wait goes on with a card showing its last lines and a Stop button, on the web and on the phone, and
  the bot is woken in the same conversation when it ends. The menu shows how many run and stops them all; turning
  the switch off, a change of who is signed in or quitting the app stops them too.
- A manager bot answers the cards waiting on you in your words, such as "say yes to the mail and tell the writer to
  keep it warm". When you said it in your own conversation with the manager, and the manager has read nothing from
  outside, it answers straight away; otherwise you see all its answers on one card first, at every permission level.
  Cards that use money, passwords or codes, your own computer or phone, a second person's yes, a lookalike site or
  another manager's own step stay with you. An answered card says which manager answered it, and the waiting bot is
  told the answer came through the manager. The manager never turns on "always allow".
- A daily check-in: once a day, at the person's reminder time, their bots are looked over with no AI for what has
  gone wrong and waits on them: a routine that keeps failing, switched itself off and is still off two days later, or
  waits for a sign-in; a card left unanswered for more than twelve hours; a connection of theirs that signed out or
  reports an error. When something is new, a manager bot they may talk with (else the bot they last wrote to) tells
  them in their conversation and in the chat app they talk from, in a turn that may only look; nothing changes until
  they answer. When nothing is new nobody hears of it, and what was told is not told again for a week while it
  stands. Each person turns it off in their profile.
- A room can start fresh from its menu, on the web and on the phone: every bot's session in the room ends, and its
  next one reads only what is said after the line the room leaves there. The room then opens empty; the earlier
  conversation is not deleted and shows again from a button at its top, and the room's own notes stay. It is refused
  while a bot speaks or waits its turn.
- A routine's flow canvas can be zoomed (with its buttons, Ctrl or ⌘ with the wheel, a trackpad pinch, or Ctrl or ⌘
  with plus, minus or zero), fitted to the view, arranged in one click and seen whole in a small overview, where a
  click or a drag brings that place into view. Notes can be written on the canvas, moved, sized and coloured; they are
  saved with the routine and are not part of its steps.
- A routine can have inputs: names written as `{{name}}` in its instruction and in its steps' texts, each with a
  usual value. Run now asks for this run's values, filled in with the usual ones, without changing the routine; a
  scheduled or triggered run, and one waiting for the run before it, takes the usual values. The flow's boxes mark
  the names, and the settings offer to add a name the texts use but that has no input yet.
- A manager bot can set up a team of bots in one go with `bot_factory`: up to five bots with their instructions,
  skills, routines and notes, listed on one card. A yes sets all of it up at once and a no sets up nothing; the card
  is asked at every permission level. The bots start as one the manager creates does (auto level, off the internet,
  in its section, the person's own), and the routines start switched off. A bot name that is taken is refused, and
  one taken while the card waited saves nothing.
- A routine's rehearsal can compare two models: the same input, or each of the last inputs, is rehearsed on each
  model one after the other and shown side by side with each one's status, report, steps it would take, real cost
  and time, and each model's totals. It shows what happened rather than a score, and like any rehearsal it records
  no run, so the routine's history and its versions' cost are unchanged.
- A routine's condition can look at a number, with no AI: read from an app's tool or a web address (at a path in
  its JSON, or after a label on a page), it holds above or below a threshold, or once it is more than a percent away
  from the average of its last scheduled readings. The run then starts with the number and the average, so the bot
  can look into why. Each scheduled time keeps one reading; until three are kept there is no average, a number that
  could not be read is neither kept nor taken as zero, and looking at the condition outside a slot keeps nothing.
- A routine's wait step can wait for a chat reply: it goes on with the person's answer in the run's conversation, a
  reply to the run's message from a chat app, a WhatsApp reply that comes back to the run, or, when the step names a
  filter such as `text~=onay`, a Telegram, Slack or WhatsApp message in the main conversation that meets it. Only the
  routine's own person counts; the answer goes on to the next step and starts no turn of its own.
- Sign in with Claude: connecting Claude (first-run setup and Settings → Connection) now starts with a Sign in with
  Claude button. The server runs the Claude Code program that comes with it, so nobody has to install Claude Code or
  open a terminal for a subscription token. On the computer the server runs on, the sign-in page opens in the browser
  and comes back by itself; with the server elsewhere, you open the page from the app and paste the code it shows.
  Claude Code keeps and renews the login where the bots read it; a saved token or API key is removed, as the login
  takes its place. The token and the API key stay under "Other ways".
- A routine's bot step can be done by another bot: pick it under "Done by" on the step, in the list or on the flow, or
  a bot names it with `by_bot`. That bot does the step with its own settings, apps and account, in its conversation
  with the routine's bot, for the routine's person; its answer shows in the run's conversation and goes on to the steps
  after it, which are the routine's own bot's again. A bot that is archived, or that the routine's person may not talk
  with, is refused when the routine is saved, and fails the step along its failure way when it starts.
- Suggest a fix, in a routine's health: its bot's model reads the routine's last ten runs and proposes a corrected
  instruction and bot step instructions, with why, next to what it has now. Nothing changes until you press Apply;
  Undo, or an earlier version of the instruction, takes it back. Only the person who set the routine up can ask, what
  looks like a secret in what the runs wrote is cut before it is sent, and the call counts toward the bot's usage.
- The phone app shows a routine's health too: Settings → Routines names the routines that want a look, and a
  routine's page has the same numbers and findings as on the web, with Apply (and undo), Ask the bot (the message waits
  in the bot's chat for you to send) and Hide.
- Settings → Usage lists what sits unused, worked out with no AI: skills no bot has read for 60 days, bots with no
  turn for 60 days, and connections no bot could use for 60 days (open to none, or signed out). A bot with a routine switched on, a
  chat app it answers in or bots it looks after is left out, and so is a connection a routine checks or waits on. Each
  can be cleared away from there: a skill or connection is removed after you say yes, as that cannot be undone, and a
  bot is archived with a way to take it back. Only what you may change is listed, and nothing goes by itself.
- A routine's history keeps each version whole: its instruction, steps, model and condition, not the instruction
  alone, and a new version only when one of those really changed. Each version says what changed and how its runs
  went (done, nothing to report, failed, what they cost, how long they took), marked when it has too few runs to go
  by; bringing a version back puts all of it in the form. Runs from before versions were kept are counted apart, and
  versions kept before this with the instruction alone bring back only that.
- A routine's ways can go back to an earlier step, so a run can read a page every half hour until what it waits for
  is there, or have a step write a draft again when the step checking it does not like it. What the step the way
  leaves hands on reaches the step it goes back to. A run goes back 20 times at most; one that never comes out of
  its loop stops there as failed. An approval step can also have a way for a "no": the run goes on at that step
  with what the person turned down (a step that writes it again, a note to someone) instead of stopping. A bot that
  sets or changes that way asks on a card first, since a "no" could lead where a "yes" does. The flow view draws
  each way with an arrow at its end, so one that goes back reads as such.
- Memory can be seen as a map (Memory → Map): each note a dot coloured by whose it is, clustered by owner, linked to
  notes about the same site, written in the same conversation, or, with search by meaning on, near it in meaning. A
  dot opens the note to fix, pin or forget, as in the list.
- A routine started by something (a mail, a webhook, a watched page) can be rehearsed on the inputs of its last runs at
  once: up to five, one after another, with a list of what it would have changed or sent for each input. Nothing is
  done; each rehearsal is billed like a run, and the button says how many it starts.
- Each conversation has an action log (in the conversation's menu): the turns that changed or sent something, newest
  first, each listing what can still be taken back, what was, and what no one can take back, such as a mail that went
  out or a call to another service. A turn can be taken back from there.
- A bot can have a reviewer: a second model, best of another family than the bot's own, that reads a mail about to
  go out, or data about to leave, while its card waits for you. When something looks wrong (an address the request
  never named, private data going out, a step that does more than was asked, text the bot read steering it) it adds
  one line to the card. It never decides, never holds the bot up and adds no cards; a card it finds nothing on stays
  as it was. Searches, page reads and looks at the browser are left alone. The step, with the mail's text, goes to the
  reviewer's provider too. The line shows in the app and on the phone; a chat app shows it only if it came before the
  card was posted there. Off by default; set it in the bot's settings. Its cost shows on the usage page.
- Each routine shows its health: how its runs of the last 30 days ended (done, nothing to report, failed), what they
  cost and how long they took, worked out from the runs with no AI. It points out a routine that keeps failing, that
  switched itself off, that waits for a sign-in, a step that keeps failing, a wait that keeps running out, runs that
  mostly find nothing to report with what they cost, and a routine not used for 30 days. A wait that runs out can be
  made twice as long with one press, and undone; for the rest, "Ask the bot" puts a message about it in the bot's
  chat for you to send, asking the bot to check with you before it changes anything; the bot then changes the routine
  only as far as its permissions allow. A finding you hide comes back only when the runs after that meet it again.
  Settings → Routines shows each routine's health and can list only those needing attention, and Today says how many
  have a problem.
- Two routine steps work with data and no AI. A fetch step reads an https address (a page as its text) and hands
  what it got to the next step; after the server name the address can carry a value the run saved, as `{{name}}`.
  An extract step takes values from the JSON that reached it, one `name=path` per line, saves them as the run's
  values for `{{name}}` in later steps, and hands them on as JSON, so a condition, a notify step or a bot step can
  use them. A routine that reads a price and tells it, say, no longer needs a model turn for it. A fetch step runs
  only while the bot may reach the internet, refuses addresses in the local network and answers over 256 KB, and
  marks the run as one that read outside text. When either fails, the run can go on along the step's failure way, as
  with a bot step; otherwise it stops there and can be tried again from that step.
- A routine's steps can branch. When a step's condition does not hold, the run can go on at a later step instead
  of only skipping it or ending; after a step ends, the run can end there or go on at a later step, so a "yes"
  branch does not run into the "no" branch after it; and when a bot step really fails, or the bot says it could not
  do it, the run can go on at a later step with why it failed (a backup source, or a note that it did not work)
  instead of stopping. Ways only go forward. Steps a run goes past show as not on its way, and the flow draws each
  way as a labelled line, with the way the latest run took in colour. Set them on each step in the routine's window,
  in the list or the flow, or ask the bot; the approval card lists them, and a new way past an approval step is
  asked about. A failure the routine handles this way does not count toward switching it off.
- A bot can use your own computer on Windows too, as it could a Mac: look at the screen, click, type and press
  keys, for work in apps that only run there. Shortcuts follow the system: on Windows the bot uses ctrl, and is told
  so; a window running as administrator, or a sign-in or User Account Control screen, is out of its reach and it
  asks you to do that step. The switch in a bot's settings now reads "Can use my computer".
- A bot can use your computer when the server runs elsewhere, such as on a Linux host: in the desktop app on your
  Mac or Windows computer, connected to that server, turn on "Bots may use this computer" in the Leaf Bot icon's
  menu. It is the one way that server reaches your computer, and it is off until you turn it on. The computer is the
  one of the person signed in in the app, and only their own bots' work in their own conversations uses it. Before a
  bot first sees or touches the screen, the computer asks on its own screen, naming the bot and the server; that yes
  lasts until two minutes pass with nothing done, or fifteen minutes at the latest, and "Stop the bot using this
  computer" in the same menu ends it at once. After a no or a stop it does not ask again for half a minute. The
  desktop app passes on only looking, clicking, typing, keys, scrolling and dragging, never commands or files;
  screenshots go to the server as JPEG. On such a server anyone who may change a bot may let it use the computer of
  the person it works for; on a server that runs on the owner's own computer, still only the owner may.
- A bot can delete finished tickets (done or won't do) from the board when you ask; open work stays until it is
  set to won't do. Taking the bot's turn back puts the tickets back with their comments.
- A routine's step can run only when what the step before ended with has (or lacks) a text, passes a JSON filter,
  or is anything at all; looked at with no AI, so a check that finds nothing costs no model. When it does not hold
  the step is shown as skipped and the next step gets what reached it, or the run ends there and reports what came
  so far. Set it on each step in the routine's window, in the list or the flow, or ask the bot; the approval card
  shows it on the step.
- A manager bot can set up a routine for a bot it looks after, as it could already change and remove theirs; the
  card names that bot. It still cannot for another manager.
- A routine can wait for something before its scheduled run starts, looked at with no AI: enough files matching a
  pattern in the bot's or group's folder, a mail or WhatsApp message that meets a filter, a table row, an answer from
  a connected app's read-only tool, or a word on a page; each check can also hold when the thing is absent. When the
  condition does not hold, no model is asked: the run is shown as skipped, a row of such slots stays one line, and an
  optional note you wrote is posted as it is. It can look again every few minutes until a time of day, then keeps to
  its schedule. When a check cannot be read (an app down, a table gone), the run is an error and the note is not
  sent, so a failure never reads as "nothing came". A run you start by hand, or one an event starts (a mail, a
  webhook, a table row), does not wait. Set it in the routine's window under "Only when something holds", or ask the
  bot; a bot asks you on a card before a condition reads WhatsApp. The server migrates its database on start.
- A bot can start one of its routines at once, or rehearse it, when you ask it to try a routine.
- A bot that is asked to connect an app you already connected, but that is not open to it, asks you on a card to
  open it to that bot too instead of connecting it again; it works with your sign-in. A team connection is opened
  this way only for those who look after the server.
- Bots can set up a routine's steps when you ask them in the chat: steps after the instruction, each agent step on a
  model of its own (a cheap check first, the real work on a stronger model), approval steps that ask you, notices with
  no AI, and steps that wait for a time, a webhook or a mail; also a webhook's filter and a Slack channel and reaction.
  The approval card lists every step. A bot reads a routine in full before it changes it, with each step's id and
  model and how the steps of the latest runs went, and keeps the steps it leaves as they were. Taking an approval step
  out of a routine, or moving a step that came after it ahead of it, is always asked about on a card, whatever the bot
  may do by itself. A misspelt model for the routine or a step is refused when the bot sets it, rather than failing
  later in a run nobody watches. A webhook's signing secret stays yours to enter in the routine's window.
- A manager bot can also set a bot's effort, turn its memory on or off, and pick its object avatar and surface, when
  it creates the bot or later. Spending limits, your Mac, the tool selection and a coding agent stay yours to set in
  the app.
- A bot's object avatar can wear a coat of fur: pick "Fluffy" under Surface in the bot's window, beside the shapes
  and colours. The choice is kept per bot and shows wherever the bot appears in the app. The phone, and a browser
  without WebGL2, keep drawing the body smooth. The server migrates its database on start.
- A routine can be set to "Only tell me": it looks and reports, and whatever the bot may do elsewhere, it changes
  nothing in those runs. A step that would change something (sending, clicking or typing in a page, writing a file,
  a connected app that writes, handing work to a looser bot) is refused, not asked, and the bot is told to write what
  it found instead; no approval card appears. The bot keeps its own notes and follow-ups and can still show you
  files and pictures. It holds for every step of the routine, for a run held or retried, and for a rehearsal, and
  never reaches your own messages in the same conversation. Set it in the routine's window, or ask the bot ("just
  tell me every Monday"); it is carried in a bot file too. The server migrates its database on start.
- A routine whose runs keep failing switches itself off after 10 failed runs in a row, so a broken instruction, a
  removed tool or a page that changed stops spending money. You are told in your main conversation, and the routine
  shows why it is off; when you turn it on again the count starts over. A usage limit, an expired sign-in, a server
  restart, a run you stopped and a provider that is busy for now do not count, and a run that works resets the count.
  The server migrates its database on start.
- Bots can ask a question where you tick several options and confirm, in the app and on the phone; in chat apps you
  reply with the option numbers, such as 1, 3.
- Bots can read a routine in full before they change it, offer to update a routine when you correct a fact it relies
  on, and report the state of their work in plain words, without internal ids or tool names.
- When the provider refuses a request on content grounds and a backup model is set, the backup model takes over (if
  nothing had been changed yet) instead of the turn ending with an error.
- Contact cards sent over WhatsApp are read by the bot with their names and phone numbers.
- A voice call reads out replies the bot starts on its own, such as a routine's result, while you are listening.
- The desktop app on a Mac offers once to move itself to the Applications folder when it runs from a disk image or a
  download that macOS keeps apart, so updates can install. "Check for Updates…" in its menu says when a check fails,
  and why.
- Bots running commands on your Mac can ask for access to Calendar, Reminders and Contacts.
- `tel:` and `sms:` links in a reply open the dialer or Messages on the phone.

### Changed

- A long conversation opens faster: the app and the phone apps read its latest 50 messages instead of 500 and bring
  in older pages as you scroll up; the app draws the latest ones first and the earlier ones in the frames after.
  Opening a conversation of 500 messages or more held the page for about half a second. A message row draws again
  only when it changes, where a reply streaming in redrew every row. `GET /api/threads/:id/messages` takes `limit`
  (1–500); without it the server still sends 500, so phone apps from before keep working, and the new ones work
  with a server from before.
- The buttons at the foot of the sidebar have icons that tell them apart: a sun for Today, a checklist for Tasks, a
  bar chart for Dashboards and a grid for Apps. Dashboards and Apps had two near-identical sets of squares. Tasks show
  the same checklist in a conversation and on a message.
- Dashboards open over the whole window. Their tiles fill each row instead of leaving an empty column beside a wide
  chart, and tiles in a row are the same height.
- A row of figures on a card or a dashboard wraps where the figures do not fit side by side, so a number stays on one
  line with its unit and a label shows in full on up to two lines; framed figures in a line are the same height.
- A bot's computer goes to sleep after its quiet time even while its screen is open in the app, instead of staying
  on for as long as the panel is shown. A bot step, a command left running and a person in control still keep it on;
  it wakes again on the bot's next step or with Wake.
- A bot with its own computer runs ordinary commands in the server's sandbox again, as other bots do, instead of
  waking its whole computer for each one. Its computer's terminal stays for what only the computer has (Python with
  its spreadsheet and document libraries, LibreOffice, git to GitHub with the team's key). Where the sandbox cannot
  start, commands still go to the computer.
- The bot's browser tells sites the interface language, instead of an empty or invalid one on servers whose locale is
  C or POSIX.
- Screenshots of a bot's computer go to the model as JPEG of the same size, which costs fewer tokens.
- Card expiry dates can be typed in any usual form (1227, 12-27, 12 2027, 2027-12).
- A long reply no longer scrolls its beginning out of view while it is written; the view stays at its start.
- A routine's scheduled run waits while an earlier run of it is waiting out a time between its steps, no longer than
  the time between two of its slots, so a routine that reads a page every half hour until something is there no
  longer reads it twice. A longer wait, or a run held for an approval or an event, still lets the schedule go on, as
  it may wait for days.
- Files on a message are listed one under another, each with an icon coloured by its kind (document, PDF, web page,
  sheet, slides, code, archive) and a download button beside it, so a file the preview can show no longer has to be
  opened to be saved. Pictures and players still sit side by side, and the download-all button comes after the list.

### Fixed

- The usage export (Settings → Usage) and a bot's list of steps as CSV start with a UTF-8 byte order mark, as
  a table's export already did, so Excel no longer garbles bot names with letters such as İ, ğ or ş.
- A browser that reaches the relay while its server is restarting connects as soon as the server is back,
  instead of after about 20 seconds. The relay drops what the browser sends while the server is away; the
  offer was sent again once the server returned, but its network addresses were not, so the server could not
  reach the browser and the attempt failed only when ICE gave up.
- `docker/firewall.sh` removes the YUMAKBOT-EGRESS and YUMAKBOT-INPUT chains an install from before 0.7.0
  left on a host that has not restarted since. They held the same rules as the new chains, but undid the ports
  `HOST_PORTS` opens. They go only after the new chains are in place.
- Deleting a bot first stops any work it still had going, such as a run queued after it was archived, so
  nothing writes to a bot whose rows are being removed.

- A coding agent bot (Gemini, Codex, OpenCode, Kimi) that stopped waiting for an approval card no longer has
  the step run when the card is approved later. The agent had already counted the step as failed and might
  try it again, so an email, say, could go twice. While a card is open, the app also tells an agent that asks
  for progress that the step is still under way, so it can keep waiting.

- Clicking Send kept the cursor in the message box, so the next message can be typed at once. Before, the
  click took focus away and another click on the box was needed.
- A routine switched off by hand now says Paused in the bot's panel and in Settings → Routines; only the switch
  showed it before.
- Reading a reply aloud on a device with no voice for its language now says so and how to add one, instead of a
  voice for another language reading it as nonsense.

- When the server on this computer cannot start, the desktop app's error box now offers Try again, Show logs and
  Close. Before, it only had OK, and the app stayed in the menu bar with nothing open and no way to retry.
- A desktop app set to a remote server no longer starts this computer's own server when the system keychain is
  not open yet, which happens on Linux when the keyring comes up after the app. It waits a few seconds for the
  keychain, then asks whether to try again or use this computer's server for this run; the remote choice stays
  saved. Before, it quietly switched servers and the person's bots seemed to be gone.

- The bot's desktop browser no longer opens a print dialog or asks to share its location. Both dialogs are Chrome's
  own windows, which the bot cannot see or close from the page, so a site that asked for either left the browser
  stuck behind a box. Printing is now off and location requests are refused by the browser's policy.

- An OpenCode bot at "Ask first" now asks before running a command, changing a file or reaching outside its folder.
  OpenCode lets every step through unless its settings say otherwise, and the app only hears about the steps an
  agent asks about, so these ran with no card. Leaf Bot now starts OpenCode with those three kinds of steps set to
  ask, over whatever the person's own OpenCode settings say; both OpenCode 1 and 2 read the rule.
- A message added to a running turn is no longer lost when the provider cuts the reply and the same request is
  tried once more: the second try carries it. Before, the message counted as answered and went unread.
- A reply the provider sent empty or broken (no answer, unreadable JSON) now moves the turn to the backup model,
  as a busy provider does, as long as the turn has not changed anything yet. Before, the turn ended with the error.
- A connected app whose tool lists allowed values without a type no longer fails turns on Google models: the type
  is taken from the values. Google refuses such a field and with it the whole tool list.
- A coding agent bot whose agent cannot take MCP servers over HTTP now says once, as its conversation with the agent
  begins, that it works without Leaf Bot's tools. Before, it could only claim to have saved a note or sent a message.
- An API key pointed at another Anthropic-compatible service now names that service when it refuses for its
  balance or its content rules, not Claude's own account.
- Claude bots no longer switch into Claude Code's plan mode, whose approval the app had no card for.
- A coding agent's step that is reported only once it has finished is no longer held as running, which kept the
  turn's watchdog at the long limit of a running tool.
- On Telegram and WhatsApp a bot that hands the work to another bot and says nothing yet no longer sends "There
  was no answer to this request": the answer comes once the other bot replies.
- On Telegram, replying to a message the bot does not know (one forwarded to it, or from before the chat was
  paired) now brings that message's words to the bot, quoted above the reply, as outside text. Before, the bot only
  saw "do this" and not what "this" was.
- Archiving a bot now stops the work it was in the middle of, with a note in its conversation, whether the person
  or a manager bot archives it. Before, a running turn went on against a bot that was put away, and could still be
  at work when the bot was deleted with its folders.
- A bot talking to someone who may only chat with it no longer offers to save a new skill it cannot save; it may
  still suggest fixes to the skills it has.
- The server now starts when one of its parts cannot (a stored row it cannot read during recovery, a chat app whose
  service does not answer): that part is written to the log and the rest opens. Before, the whole server stopped,
  and the desktop app only said it kept stopping.
- Work a server restart cut short now picks up where it left off. A person's request or a routine's run that was
  under way when the server stopped (a deploy, an update, a crash) goes on by itself once the server is back, in the
  same conversation and engine session, and the bot is told to look at what the cut attempt already did before going
  on, so a sent mail or a written row is not done twice. Before, the request stayed stopped until someone pressed
  Retry, and a routine run that had already changed something ended as failed. It goes on once: if it is cut short
  again it stays stopped. Another bot's request, a request from a chat app, a guest's request and a rehearsal are left
  as before. Retry on the stop note of a routine's turn, which only said the request could not be run again, now
  opens the run again and has the turn go on where it left off, at the step it was at; this works on notes left
  before this change too.
- A WhatsApp message a routine drafted could later be taken for unsent. The bot was told the card's outcome would come
  with its next message in that conversation, but it is written in the main one, so the routine noted "on the card"
  and another routine read that as not sent though the person had sent it. A draft made outside the main conversation
  now tells the bot where its outcome goes and to check the chat instead, and `whatsapp_history` shows the bot's
  drafts not sent yet next to the messages that went, so any run can tell which happened.
- A bot that committed on its computer made up its own author, as git there had none, and GitHub credited those commits
  to whichever stranger's account owned the made-up address. A command's commits are now written by the account of the
  GitHub key the command uses (the person's own, or the team's), with GitHub's private address for it, so they reach
  the right profile and show no real email; a name or email the bot gives git itself does not win over it. The server
  asks GitHub once which account a key is and keeps the answer for a few hours.
- A command a bot ran on its computer for more than five minutes ended with "The computer service cannot be reached"
  while it was still running: the server stopped waiting for the answer after five minutes. It now waits as long as
  the command may take, and a command that outlasts that is reported as not answering, with a note that it may still
  be running.
- A bot that asked another bot, read the answer and asked again went one level deeper in the chain each round, so
  its fifth message, even a notice, failed with "Chain too deep" although nothing was nested. Only work a bot hands on
  while answering counts now; a chain's overall limit on requests still stops rounds that never end.
- After Leaf Bot was updated, a bot whose conversation had already loaded a tool kept working by that tool as it was
  before, and said that a field it had was missing (a routine's steps and condition, say). Such a conversation now
  moves on to a new session with the recent exchange, once, and a line in the chat says which tools changed; a
  conversation that never loaded a changed tool keeps its session.
- On Linux, a bot on an API-key model can run commands again when the server is installed under the home folder;
  every command failed with "No such file or directory", because the sandbox's own helper was hidden with the home
  folder.
- Words you write on a WhatsApp draft's card instead of picking Send or Don't send now reach the bot: the message is
  still not sent, and the bot reads what you wrote and answers it or redoes the draft. Before, such an answer counted
  as a plain "no" and the bot never saw it. The same goes for the front door's card suggesting a bot for a chat: words
  written there leave the chat with no bot, and the front door reads them (to suggest another bot, or answer you).
  And on a manager bot's card asking to change another bot, words written instead of Approve or Decline reach the
  manager with the refusal.
- A message you write in the chat while the bot waits on a card of several questions, or one asking for a secret, now
  reaches the bot at once: the card closes as skipped and the bot reads your words in the same turn. Before, the
  message waited until the card was answered. A card of one question still takes what you write as its answer.
- WhatsApp no longer wipes its link when the server's secret key changes; it says the saved keys cannot be read and
  asks you to link again. Telegram, Slack, Discord and Teams show as not connected, with a reason, when their saved
  tokens can no longer be read, instead of showing as connected while doing nothing.
- A Discord reply with text and one file arrives as one message.
- A coding agent that never answers on start no longer holds the bot's queue: Stop works at once, and a start that
  takes over 90 seconds ends with a message.
- A long conversation summary no longer gets the turn stopped as stalled.
- An OpenAI conversation whose saved reasoning the provider can no longer verify goes on in a new session instead of
  failing every turn.
- A Claude bot that says what it will do next and then stops is told to go on, up to twice, as API-key bots already
  were; not while it waits for another bot's answer.
- When reading a message aloud fails, you see why instead of silence.
- Empty (0-byte) files are refused with a clear message.
- A reply that is only a picture shows the picture's name in the sidebar instead of a blank line.
- The screen stays on while a bot is using your Mac, so its screenshots are no longer black.
- A message sent from the phone as the app comes back from the background is sent again by itself once the
  connection is back. Large uploads from the phone are no longer cut off after ten minutes while they still move; only
  an upload that stalls for a minute is.

### Changed

- All fifteen languages cover the whole interface. The ten that were translated for the first screens
  only — Arabic, French, Hindi, Indonesian, Italian, Polish, Portuguese (Brazil), Russian, Ukrainian and
  Vietnamese — now carry every text, and German, Spanish and Chinese the keys the routine changes added,
  so nothing falls back to English in a language someone picked. The new texts were drafted from the
  English catalog and want a native read before a language leaves beta.

## 0.9.1 — 2026-11-23

### Added

- The iPhone app's icon shows how many bots have replies you have not read, as the desktop app's Dock icon does. The
  phone tells the server which bots are unread, and the server counts on from there with each notification it sends,
  so the number grows while the app is closed. It counts bots, not messages. It needs this server and the next store
  build of the app; an older build is sent no number.

### Changed

- Routines run in the bot's main conversation by default, and existing ones move there, so the bot does its own work
  where you talk to it. Routines that read WhatsApp, report to Slack or stop for you keep their own conversation, as
  do runs started by outside text; their reports still reach the main conversation.
- A card asked while bots work for each other shows in the conversation where the work began, however deep in the
  chain it was asked. Conversations between bots are no longer listed or searched on their own; they are read behind
  the marker line in that conversation.
- The iPhone app's icon is the same layered icon as the desktop app's, from the next store build.
- The interface is fully translated into Simplified Chinese.

### Fixed

- A message sent while the bot was answering, or right after a stop, no longer leaves the chat showing "working" with
  nothing on screen, and a connection that drops mid-reply no longer loses the text written so far.
- The phone app's message box grows with its text again instead of staying one line high.
- The language choices on the first screen fit in the window, with the Continue button in view.

## 0.9.0 — 2026-11-23

### Added

- The iPhone app shows a bot's work on the Lock Screen and in the Dynamic Island: after you send a message, a Live
  Activity names the bot, says whether it is working, needs you, is done or ran into a problem, and counts the time.
  The server moves it along through Apple's push service with the same key as notifications, so it keeps up while the
  app is closed; it dims if nothing new comes for half an hour and leaves the Lock Screen a while after the work ends.
  It needs an installed build of the app (not Expo Go) and can be turned off under Settings → General → Notifications.
- A color tone beside the light and dark theme, in the web and the phone app: Neutral (as before), Slate or Leaf. It
  tints only the gray surfaces and keeps their lightness, so text reads as well in each, and leaves the words, buttons
  and each bot's own color as they are. It is kept per device under Settings → General.
- The phone app takes new versions of its code without a store release, from the EAS project it is released from. It
  looks when it opens and when it comes back to the front, at most once an hour, uses an update from the next start and
  offers to restart into it at once. Settings → About shows which version is running and checks on request. An update
  reaches only builds of the same app version, so changes that need new native code still go through the store.
- A routine's steps can be shown as a flow: boxes on a canvas for what starts it, its instruction and each step,
  joined by lines in the order they run. Each box is edited where it is, the first one with the schedule and the time
  of the next run. Boxes are placed by dragging their title or with the arrow keys, and the places are saved with the
  routine; the order changes from a box's menu or with Alt and an arrow key, and a step is added on a line. While a
  run goes, each box shows how its part of the latest run went and what it ended with, and an approval waiting there
  can be answered from the box. "Try" on a box rehearses its instruction without doing anything; a step is tried on
  its own, without what the step before it ended with. Steps still run one after another: a flow has no branches.
- A bot can say what it does not know. When it notices during a task that a fact it needs is missing from its memory,
  or that a note or skill disagrees with what it just saw, and it does not know the right answer, it leaves a flag
  instead of guessing. Flags show under Settings › Memory as "Missing knowledge", most often raised first, and on Today
  as a count. Your answer becomes your own note (or the flagged note's new words, or a change to the skill, which waits
  for the skill's owner when that is someone else), so the gap is filled once for every later task. A flag also closes
  by itself when the note it is about changes, when you say the answer in a later conversation the memory review
  reads, or when a page the bot named plainly answers it: that answer waits for your yes as a memory change. A flag
  raised after the bot read outside text (a mail, a web page) is shown as such and is never settled without you. One
  turn leaves at most three flags and a bot at most 50 open ones; a flag raised once and left for 60 days goes, and
  taking a turn back takes its flags too. Bots with memory turned off, and people with no account here, have none.
- A bot can listen to a call it joins in its browser and write it out. Ask it to join a Jitsi, Google Meet or
  Microsoft Teams link: it opens the page, joins with its usual browser steps under a name that says it takes notes,
  and listens once you agree on a card, which comes every time and has no "always allow", since the other people's
  voices go to the speech-to-text service. What is said is written out every 30 seconds into a file in the
  conversation's folder; silence is not sent and no audio is kept. The audio is taken in the page itself, so the
  computer needs no sound device. When the call ends (the page leaves it, nobody speaks for 15 minutes, or after 3
  hours) the bot is started again to write you notes of the call; the transcript counts as outside text. It is offered
  only in work your own message started, not in routines, team chats, to guests or to a bot that may only read, and it
  needs a speech-to-text service. Speakers are not told apart. The bot's browser keeps WebRTC to its proxy, so the call's
  sound comes through the meeting service's relay over TCP; a service that offers none cannot be heard.
- German. Pick "Deutsch" on the sign-in page or under Settings › General; the phone app follows the phone's language.
  The web app downloads the German text only when it is picked. Bots are told to answer in German; what the server
  itself writes (approval sentences, error messages, system lines in chats) stays in English. A text added after the
  translation shows in English until it is translated.
- Twelve more languages: Arabic, Spanish, French, Hindi, Indonesian, Italian, Polish, Portuguese (Brazil), Russian,
  Ukrainian, Vietnamese and Simplified Chinese, picked the same way as German. Each one translates what a person meets
  first, the sign-in, the navigation, the main settings and the whole chat screen, and shows English for the rest;
  Settings › General says so under the language picker, and `pnpm i18n:coverage` lists what is left per language.
  Plurals follow each language's own forms, and Chinese, Arabic and Hindi text gets a font that holds its script.
  Arabic turns the web and desktop app right to left, mirroring the layout and the arrows; the phone app shows English
  for Arabic until it can mirror too. Bots are told to answer in the picked language, and a message that only says stop
  in any of them stops the bot's work as the Stop button does.
- A bot can use your own Mac: look at the screen, click, type and press shortcuts, for work in apps that only run
  there. Turn on "Can use my Mac" in the bot's settings; only the server's owner sees it, and only in the desktop app
  on macOS, where the server runs on that Mac. The first look or touch in each piece of work asks on a card, whatever
  the bot's level and with no "always allow"; after a yes, looking, clicking and plain typing go on in that work
  without another card, while Return, a shortcut or text with a line break asks each time, since it can run or send
  something. It is offered only in work the owner's own message started: not in a routine, a mail, a webhook, a
  follow-up or another bot's request, not in team chats or to guests or other people, and not to a bot that may only
  read. What the bot sees on the screen counts as outside text. One bot uses the Mac at a time. macOS asks once for
  Accessibility (mouse and keyboard) and Screen Recording (seeing other apps' windows); the switch says which is still
  missing and opens the prompts.
- A voice call with a bot: the phone button next to the microphone starts it. You talk, and once you pause what you
  said is sent; the bot's answer is read aloud and the call listens again. The bot knows the message came from a call
  and keeps its answer short. It writes out speech with the server's speech-to-text service, where talking over the
  answer stops it; without one it uses the browser's own recognition (Chrome, Safari), which waits until the answer
  has been read. Answers are read with the server's voice or the system's.
- A bot can run on a coding agent installed on your computer instead of a model: Gemini CLI, Codex (through
  `codex-acp`), OpenCode or Kimi Code, spoken to over the Agent Client Protocol. Pick it as the bot's connection; the
  agent uses its own sign-in and its own model. Only the server's owner can choose it, and only in the desktop app,
  where the server runs on that computer. The agent works outside the bot's protected folder with its own file and
  shell tools, so such a bot carries out only the owner's own messages in their own conversation: not a routine, a
  mail, a webhook, a team chat, a room, a guest or another person, and a bot that may only read is refused. Every step
  past reading that the agent asks about (a command, an edit, a fetch) comes as a card at every level, without "always
  allow". The bot's own tools (memory, files, apps) reach it through a local MCP server and go by the usual rules;
  steps the agent takes without asking are not stopped by the app.
- A routine can start on an app's event: with the routine's webhook on, pick the app (GitHub, GitLab, Stripe, Shopify,
  Linear, Sentry, Calendly or Typeform) and the event (an order paid, a payment failed, a pipeline failed, a form
  answered…). This fills in the webhook filter and shows what to set in the app. Each app's signature is checked:
  apps you give the routine's secret to are checked with it, and for apps that make their own secret (Stripe, Shopify,
  Linear, Sentry) you paste it into the routine, after which only calls signed with it start the routine. Stripe and
  Calendly calls signed more than five minutes earlier are turned away. Removing the webhook removes the pasted secret too.
- A bot can read from your own phone: your calendar, your contacts (by name) and where the phone is. Each is off
  until you turn it on in the phone app's settings under "This phone", which asks the phone's own permission; it is
  kept per server. A bot reads it only while the app is open and connected, only in work your own message started in
  your own conversation (not a routine, a team chat, a guest or someone else), and not when it may only read. The
  first read in each piece of work asks on a card at every level, with no "always allow"; what comes back counts as
  outside text. Nothing on the phone is changed. A new build of the phone app is needed for it.
- ⌘K (Ctrl+K) also does things: type what you want and pick it, such as a new bot, Today, the board, connecting
  apps, the keyboard shortcuts, the light, dark or system theme, or any settings section by its name or its words.

### Fixed

- The phone app's message box no longer resets the iPhone keyboard on every letter, which kept predictive text,
  autocorrection and swipe typing from working.
- Part of a message can be copied on the phone: "Select text" in a message's menu shows it where any part can be
  picked and copied, instead of only the whole message.
- The phone shows a bot's computer screen live, with waking the computer and taking control, as the desktop app does.
  It uses the server's own screen page, so a server older than this one keeps the note that points to the desktop app.

## 0.8.0 — 2026-11-22

### Added

- A routine can start when a row of its bot's table is ready, so a table works as a list of jobs the bot picks up.
  In the routine window, choose the table and, if you like, which rows (for example `Status=todo`). A row starts the
  routine once, with that row, the first time it has something in it and meets the conditions: when you fill in a row
  you added, or change one, say by setting its status. Rows the bot writes never start it, so a run that fills the
  table cannot start itself again, and neither do changes other people make. A row with cells the bot or someone else
  wrote is read as possibly holding outside text, so its run changes nothing without asking. A row that comes while
  a run is going waits for it instead of being dropped.
- Follow-ups: the bot's own calendar, kept apart from the routines. A routine is the person's standing job, shown in
  the bot's list and set up by them or on their yes; a follow-up is the bot keeping track ("on Sunday morning, bring
  up Monday's visit"). After each turn whose words or answer name a day or a time, one call to the small model reads
  them beside what is already kept and adds what is coming up for the person (a visit, a meeting, a deadline, a
  delivery, a payment), moves what was put off and drops what was called off, wherever the bot learned it: in the
  chat, in a mail it read, in a routine's report. Bots can also add one themselves. Nobody is asked, and nothing shows
  among the routines; asked, a bot lists what it keeps track of and drops what the person does not want.
- A follow-up is the person's: the same thing learned by two bots, or from two mails, is kept once. The server, not the
  model, picks when to bring it up: the morning before at the person's reminder time, else that morning, else two
  hours before, always in the day and before the thing; with no time left, not at all when the person is talking
  about it right then, otherwise as soon as it is day. When it comes up the bot that learned it gets a turn in its
  conversation with the person, reads the related mail again, looks whether the calendar has it and tells them with
  the context, offering to add it or to prepare. That turn works for nobody who asked just now and carries the mark
  of a mail it came from, so it sends, adds or changes nothing without a card: a planted mail can at most have the bot
  bring something up. Nothing still ahead is dropped because it could not come up in time: a paused bot or a spent
  limit makes it wait, a night makes it wait for the morning, and when its bot is gone the bot the person last wrote
  to tells them. It is dropped only once the thing itself is over. A follow-up reaches the person in Telegram and
  WhatsApp too, as a routine's report does, wherever they last wrote from.
- The memory is tidied once a week. Bots write notes one conversation at a time, so the same fact ends up in several
  notes and an old note stays beside the newer one that contradicts it. Each set of notes that changed since it was
  last looked at (a bot's own, a person's notes about themselves, a place's) is read whole with one call to the small
  model of the bot that wrote them: notes that repeat are merged, of two that disagree the newer one or the person's
  own stays, and plans whose date has plainly passed are deleted. Notes the person wrote or pinned are read but never
  changed, a merge never joins notes about different sites or true until different dates, and one pass deletes at most
  about a third of a set. Every change shows in the memory history as the weekly tidy-up's.
- The tidy-up also reads a note that came from a page against the page as it is now, once a month per note and at most
  ten pages a pass, a week after the note was written. When the page now plainly says otherwise about the same thing
  (a new price, date or address), the note gets its new value in about as many words and keeps its page; a page that
  cannot be read or says nothing clear leaves the note as it was. Pages are read by the server over https, never on
  this computer or the private network, and only for bots allowed on the internet.
- Skill suggestions. Every turn now keeps a short list of the steps it took, secrets taken out. Once a week the
  many-step tasks a person asked a bot for over the last weeks are grouped; a kind of task asked at least three times
  on two days, done in three or more working steps each time and covered by none of the bot's skills, is written up as
  a skill by one call to the bot's small model, from the steps that worked and what the person wrote right after the
  answer. Today shows it with its name, description and instructions to edit; "Add skill" makes it and turns it on for
  the bot, "Not this" closes it for good. Only someone who may change the bot can add it.
- The usage page shows what the memory tidy-up and the skill suggestions spent on their calls over the period, beside
  the other background checks: the sets of notes and source pages read and the notes changed, and the tasks written
  into skills and the suggestions made. A bot picked above narrows them to the calls on its account.

### Changed

- Promises no longer wait for the person. The Promises list on Today, with its "Done" and "Drop", and the line under a
  reply that made a promise are gone: a promise is the bot's to keep, not the person's to close. A bot's promise goes
  into its own calendar; one that waits for something ("when the result comes") is looked at the next morning, and
  the bot sets the next look itself while it still waits, telling the person once if a week goes by. A follow-up
  with nothing new to say (the bot already gave the result, or the thing is done) leaves nothing in the conversation.
  A person's own promise to someone else is brought up on its day, with nothing to close afterwards.
- The reminders of a person's promises, of a bot's own promises and of the tasks in approved meeting minutes are
  follow-ups instead of one-time routines, so they no longer fill the bot's list of routines, and a person who may
  only talk with the bot gets them too. Bots are told to keep something to bring up later as a follow-up, not a
  routine. Reminders set before keep running as the routines they are.
- Bots save to memory without asking. A note a bot writes in the conversation of someone who may only talk with it,
  and the meeting note such a person sends it, are kept at once instead of waiting for the bot's owner, who was asked
  to judge facts from conversations they were not in. They show in the memory screen and its history like any other
  note; a conversation a stranger with no account spoke in still writes none. Bots are told not to ask whether to
  remember something, and in the conversation of someone who may only talk with the bot both the bot and the memory
  review are told to keep anything about that person in their own notes, since the bot's notes reach everyone else
  who uses it.
- The spending limits count what the server spends in the background on a bot's account, not only its turns: the
  routine pre-check, the promise safety net, the routine, work and skill suggestions, the memory tidy-up, the memory
  review, conversation titles, meeting minutes and the reading of turns for follow-ups. They are spent from the same
  account, so a limit that left them out let the month run over. Once a limit is reached, those calls wait as the
  turns do; minutes that cannot be written for it say so and can be tried again. What the memory review, the titles
  and the minutes cost was not kept before: it is now, and the usage page lists it by kind under "Other background
  calls". Its totals by bot and model stay the turns'.
- Bots use the board on their own. Before, they worked on tickets only when the person gave them one: they handed
  work to each other by message and kept their steps in a list of their own, so the board stayed empty. Now a bot
  opens a ticket when asked for work that will not be finished in one reply, or when told to put something on the
  board, and checks first that the same work has no ticket yet. Work it gives another bot to follow up goes on the
  board too, assigned to that bot; a quick question still goes by message. It keeps the tickets it works on up to date
  with their status and a short comment, and knows which open tickets are its own. This happens only in a person's
  own conversations, not in team chats, WhatsApp or guest chats, and not for a bot whose tool selection leaves the
  board out.
- The settings cover the whole window, with their sections listed on the left and the open section in a readable
  column, instead of a box in the middle of the window that scrolled inside itself. The conversation underneath stays
  as it was, so leaving the settings comes back to it; Escape leaves unless a dialog, menu or open list takes it first.
- The phone app draws each bot as its object, acting out what it does as on the web: ribbons while it writes, an
  exclamation mark when it needs someone, a look over the page while it thinks, a hop when it is done. A bot's object
  can be picked in its settings on the phone, among the objects the connected server takes. The sign-in screens show
  the app icon. This reaches phones with the next phone release.

### Fixed

- A routine run whose bot explained why it had nothing to report and put the silent reply on the last line went out
  as a report ending in that marker. The marker is never shown now, such a run sends no report, and a quiet run in the
  person's main conversation no longer leaves its instruction there with no answer under it.
- Pasting a long line into a dialog's text box no longer widens the dialog past its right edge; the line wraps.

## 0.7.1 — 2026-11-21

### Added

- Object avatars act out what their bot does. While it thinks or runs a tool, its face stays in view: it looks up to
  one side, then goes over the page line by line with its head swaying, instead of hiding behind three dots. When it
  finishes it smiles with its eyes and hops for a moment. It follows the pointer anywhere on the page, briskly even
  as a small avatar in the list, and the large one in the bot's panel can be turned round by dragging it, settling
  back to face the person when let go.
- Plain shapes among the object avatars: circle, square, triangle, pill, diamond, hexagon, heart, cloud, leaf, drop
  and star, all with white eyes.

### Changed

- The felt plush avatars are gone, and the Shape tab with them: the objects now offer the same plain shapes, with
  more life in them. Every bot that had a shape becomes the round object, which is also what a new bot starts with.
  An older phone app or a bot file made before still sends shape names; the server keeps taking them and stores the
  round object. The starter bots and the welcome conversation use objects.
- A new logo: a smooth round green bot with two tall eyes, coming in from the corner of the dark green tile. The
  desktop, web and phone icons, the menu bar icon and the mascot on the first screens are drawn from it. The phone
  app draws its bots with the same smooth round body in the bot's colour; it reaches phones with the next phone
  release.

### Fixed

- A manager bot shows its shield, and a paused bot its pause mark, in the unfolded sidebar list too, not only in the
  folded one.

## 0.7.0 — 2026-11-21

### Added

- Microsoft Teams (Settings → Chat apps, for those who look after the server): a single-tenant Azure Bot's app ID,
  tenant ID and client secret connect it. People in that Microsoft 365 organization link their Teams account under
  Profile with a code, then write to their bots in a one-to-one Teams chat and get the replies there; a step that asks
  first comes as a card with buttons, answered as in the app. Teams sends messages to the server, so it needs a
  public HTTPS address; each request must carry a token signed with the Bot Framework's published keys for this bot
  and this Teams service, or it is refused before it is read. Files, group chats and channels stay in the app for
  now.
- Reaching the server from your other devices over Tailscale (Settings → Connection, for the owner, off by default):
  turning it on runs `tailscale serve` so the server gets an https address that only the devices on your Tailscale
  network reach, without opening it to the internet; signing in is still needed there. Nothing runs until it is
  turned on, Tailscale keeps the setting across restarts, and the server answers at that address only while it is
  shared.
- Drawing on a picture before sending it: a pen button on an attached PNG, JPEG or WebP opens it to draw on in a
  few colours and to pin numbered notes on it. "Add the marked copy" attaches the picture with the marks drawn in,
  beside the untouched original, and puts the pins' notes in the message as a numbered list, so the bot sees both
  where and what.
- Bots make slide decks: a bot writes the slides (a cover, section dividers, titles with points, a paragraph, pictures
  from its folders, speaker notes) and gets a PowerPoint file in the conversation, which Keynote and Google Slides
  open too and the person can edit. Light or dark, with an accent colour; it costs nothing and reaches nothing
  outside the server.
- Bots make short videos (1 to 15 seconds, landscape, portrait or square) with the person's saved xAI key, the same
  way they make pictures: the video is made as a job the server waits on (up to ten minutes), kept in the
  conversation's folder and sent as a file. One video a turn, since each is billed by the second; it asks first like
  a picture does. OpenAI's video API was shut down in September 2026, so xAI is the only provider for now.
- Link previews: holding the pointer on a web link in a conversation shows the page's title, description and site,
  and a GitHub pull request or issue also shows its state (open, draft, merged, closed) as an icon beside the link
  and its author. The server reads the page the first time the link is hovered (only its start, without its query
  string, private addresses refused, kept for ten minutes), so the site sees the server's address and that moment;
  on the desktop app that is the person's own connection. No picture from the page is loaded in the app. A link
  that carries something shaped like a key, a bot's private token or a long code is not read at all, so a link a
  bot wrote cannot send data out on a hover. GitHub is asked without a sign-in, so only public repositories are
  previewed.
- An emoji button next to the message box: every emoji in sections, the ones picked lately first, and a search by
  English name or keyword; the pick goes where the caret was, and Shift-click adds more without closing. The data
  comes with the app, so it works offline. Phones keep their own emoji keyboard.
- The desktop app checks spelling as you type: a misspelled word is underlined, and a right-click on it offers what it
  could be and "Add to dictionary". It is on by default and turned off with "Check spelling" in the same menu or in
  the Edit menu. On a Mac it uses the system's checker; on Windows and Linux it checks the system's languages it has
  a dictionary for, then Turkish and English, which Electron downloads from Google the first time.
- A message written while the app cannot reach the server is no longer lost or handed back as a draft: it stays in
  the conversation marked as waiting for the connection, and goes out on its own when the connection is back (the
  browser coming online, the live connection reconnecting, or a retry every 15 seconds). A second try of a send that
  did arrive counts once, and the message then says it was written while offline.
- Bots can offer work they notice (Settings → General, off by default). After answering a person, the bot's model
  looks over the conversation once more and may offer one next piece of work it could take on, on a card: "Do it"
  sends the task as the person's own message, "Not now" puts it away. It never offers to send, post, buy, book,
  delete or change settings; a conversation is looked at at most every six hours and a person gets at most three
  offers a day; and each look is counted under Work offers in usage.
- A page that hides text from people but writes it to an AI agent ("ignore your previous instructions", "if you are an
  AI agent…") is now caught when a bot reads it: in its browser (text pushed off the page, see-through, a few
  pixels tall, clipped or drawn in the background's colour, and comments) and in a page fetched without a browser
  (what the markup hides). The bot is told the text is the page's, not an instruction, and to say it found it; the
  conversation also shows a warning naming the site, once per site in a turn. Hidden text that does not speak to an
  agent, such as a screen reader's "Skip to main content", says nothing.
- On the desktop app (the server on the person's own computer), a bot that asks first now writes and edits files in
  its own folders without a card, named by their full path. No model judges the step, so nothing waits on one;
  commands, the group's shared folder, anything outside the bot's folders and "always ask" rules still ask, and a
  step the person just turned down is not let through. A server of its own keeps its wider rule for the bot's own
  machine, unchanged.
- A routine whose run finds one of its connections signed out now waits for the sign-in: its next scheduled runs
  are skipped with the reason instead of each stopping at the same card, and the routine list says it is waiting.
  The person is told once, outside the routine's conversation too: on the phone, in Telegram or WhatsApp, and in a
  direct message from the Slack app when they linked their Slack account. The first slot after they sign in again
  runs as usual; webhook, mail and Run now runs still go ahead and show the card.
- The phone app's Today page now shows expired notes, security alarms (with "Mark as seen"), steps waiting for the
  person's second yes, open promises with the reminder time, and routine suggestions; the profile settings hold the
  routine-suggestion switch and the usage settings the promise safety-net switch.
- The phone app's memory screen shows when a note is true until, lets the person set, change or clear that day when
  editing, and lists expired notes; the permission rules list shows a rule's second person, rules can be added for
  one bot and with a second person's yes (offered when two or more people could give it), and a chat card waiting for
  a second person says who said yes first and offers no "always allow".
- The phone app's bot-reply menu offers "Undo this turn" under the web app's conditions, listing what will be put back
  and, apart, what cannot be, and shows the note it leaves as separate lines; a reply that made a promise shows the
  promise line with Cancel; the routine screen has "Rehearse", with the instructions as typed, a replay of one of the
  last runs, and the result beside that run's own report.
- A routine can be rehearsed before it runs for real. A new or changed routine runs unattended and the person only
  learned what it does from what it already did, so "Rehearse" in the routine's dialog runs it once, with the
  instruction as typed (saved or not) and, for a routine something else starts, with what started one of its last
  five runs, shown beside what that run actually reported (that input is now kept, sealed and cut to 20,000
  characters, as long as the run is; older runs cannot be replayed). The bot works for the person who set the
  routine up, in a conversation of its own that is in no list and goes after 7 days. Steps that only read (pages,
  searches, files, mail and WhatsApp history, a connected app's read-only tools, commands that read the bot's own
  folders) are really done; every other step is not done, the bot is told so and to go on as if it had been, and it
  is listed as "would do" in the words the approval card uses. No card is ever asked, whatever the level or the
  rules, and the private line still stops the turn. The result shows the report, those steps in order, the reads
  that ran, how long it took and what it cost, which counts in usage as a rehearsal of that routine. Nothing of the
  routine changes (schedule, last run, carried report, failure marks), nothing is posted to the bot's main
  conversation or its Slack channel, and no promise look or undo line follows. Someone who may change the bot can
  rehearse instructions they typed; the saved routine is rehearsed only by the person it works for.
- A turn can be taken back. A bot's step can be wrong, and the person had to find and undo each change by hand, so
  every turn now keeps, for 30 days, what its file tools wrote or edited, the table rows, tickets, routines, skills
  and bot settings it changed, and the notes it wrote or changed, each with how it was before (the words of a note it forgot are never kept). A bot's reply
  gets "Undo this turn" for the person whose turn it was (admins cannot take someone else's turn back): a list shows
  what will be put back, newest first, and apart from it what cannot be, the steps that went outside (mail, chat
  apps, the browser, programs, requests), forgotten notes and files too large to keep (2 MB each, 20 MB a turn). Anything changed
  again after the turn, by a later turn or by hand, is left as it is and reported, a routine, skill, bot setting or
  bot note is put back only by someone who may change the bot, and a turn can be taken back once, when it is no longer
  running. The result is posted in the conversation.
- Routines are suggested for what a person keeps asking by hand. People ask a bot for the same thing again and again
  ("this week's sales summary" every Monday) without thinking of a routine, so once a day, for each person who has
  not turned it off, their own messages to bots of the last 45 days are grouped by meaning (when an embedding service
  is set up) or by shared words. A request made at least three times on three different days to the same bot, that no
  routine of the bot already does and the person has not turned down, becomes one small-model request on the bot's
  own account (its cost shows on the usage page) that writes a routine name and instructions in the person's
  language, with a schedule when the requests kept one (the same weekday, most days or most working days, around the
  same hour) and none otherwise. Today lists them ("You asked Ada for this 4 times, on 4 different days") with the
  instructions editable and "Create routine" or "Not this"; only someone who may change the bot can create the
  routine, anyone else is told to ask its owner, and a request turned down is never offered again. Rooms, team
  conversations, routine runs, API calls, text handed over from outside and chat-app strangers are never read, and
  each person sees only their own suggestions. Each person can turn it off in their profile.
- Promises are kept. Bots say "I'll let you know tomorrow" and nothing made it happen, so the prompt now tells a bot
  to set up a one-time routine in the same turn it promises something later. As a safety net, when a reply in a
  person's own conversation or room sounds like such a promise and the turn set up no routine, a short list of Turkish
  and English phrasings decides whether one small request on the bot's own account reads it. A promise with a time
  gets a one-time routine that does it then and tells the person in the same conversation, and a line under the
  reply ("Promise kept on the calendar: tomorrow 09:00 · Cancel") takes it back; a promise that waits for something
  ("when the price drops") is only listed, with no time made up. Bots also record promises the person made to
  others with a new `promise_track` tool, from the chat or from the person's own sent WhatsApp messages and mails
  they read in a routine, and remind the person on the due day at a time they pick (09:00 by default). Open
  promises, overdue first, are on the Today page with "Done" and "Drop", which also remove a routine still waiting;
  each person sees only their own. The safety net can be turned off on the usage page, where its cost shows beside
  the routine pre-check's.
- A step can need two people. An "always ask" rule (with or without its amount limit) can now ask for a second
  person's yes, for things like a card filled above 1,000 or a `git push` that one person alone should not decide.
  The first yes works as before, from the app or a chat app; the card then waits as "waiting for a second person"
  and shows who said yes, and the step does not run. The second yes comes from someone else who may change the bot
  (or the one person the rule names), who sees the step and who asked for it, with the first yes and when, in a
  "Waiting for your second yes" list on the Today page, and is told alone, without the conversation, which stays
  private. The same person cannot give both yeses, a "no" from either refuses it, "always allow" is never offered
  on such a card and a bot at full access still waits. If the second person is removed or loses the bot while it
  waits, the card is refused with a reason, and a rule nobody else could answer is not saved. The bot's list of
  steps names both people.
- A bot that is being steered by text it read (a page, a mail, a webhook, another bot) is now caught by two
  trip-wires that nothing the person asks for would ever touch. Every bot's prompt carries a private line it is told
  never to repeat; if that line shows up in a tool's input (as it is, percent-encoded, in hex or in base64) or in
  its reply, the step is refused and the reply is cleaned. And in Settings → API keys a person can add a "trap key":
  a made-up key with a made-up address that guards nothing and is shown to their bots like any other key; naming it
  in a request, asking for a key of that name, or reaching its address trips the wire. A trip stops the turn and the
  work it handed to other bots, moves the bot to "Ask" if it was freer, says in plain words in the conversation what
  happened and what the turn had read before, tells the person, and stays on the Today page until they mark it seen.
- A memory note can be true only until a date. A bot that saves a fact that will stop being true ("working from
  home this week", "Ali is on leave until the 5th") gives the date, worked out from today's date and the person's
  time zone, and the note carries it into the bot's prompt as "true until ...". Once the date passes the note
  reaches no prompt and no bot's search, so the bot stops acting on it; it is not deleted but moves to an
  "Expired notes" list in Settings → Memory, where it can be deleted or given a new date, and the Today page counts
  them. A note's date can be set, changed or cleared when editing it.
- A long conversation can be summarised while it is idle, before the size at which a Claude bot would summarise it
  in the middle of the next message (Settings → Model). Once a conversation is at least 70% of that size and has been
  quiet for half an hour, the server folds its session and marks the place in the chat; a message that comes
  meanwhile waits for the fold. Off by default, as after a pause the model reads the conversation again without its
  cache; the fold counts toward spending, and a paused bot or one past its limit is left alone. Bots on another
  model provider fold as they run.
- A conversation is named by the bot's model once its first answer is in: a few words on what it is about, in place
  of the first message's opening words. A title the person gives is never changed, a bot that is paused or past its
  spending limit is not asked, and it can be turned off (Settings → General).
- Settings → About has a check of the server's data for those who look after it: work that looks under way but that
  nothing runs, approval cards waiting on such work, folders of deleted bots, conversations and groups, sealed content
  that does not open, and the free disk space. A safe repair ends the hanging work as a restart would, marks the cards
  expired, and moves the stray folders into `doctor-trash` in the data folder instead of deleting them.
- A bot with a mail address can type the one-time sign-in code a site mails to it into that site's own field
  (`browser_email_code`), once a person turns this on for its mailbox (Settings → Mail). Only unread mail from the
  open page's own site, from the last ten minutes, gives a code, and each mail gives it once; a code that cannot be
  told apart is not guessed. The person can forward code mails from their own mailbox to the bot's address.
- A task taught by showing it in the browser keeps its steps with the skill, and can be done again without the model:
  from the play button by the skill in the bot's panel, or by the bot itself with `skill_replay`, which it tries
  first for a shown task. Each step finds what it acts on by the words the person saw. The replay stops at the first
  step that no longer fits the page, or that needs a password, and says which; the person can hand the rest to the
  bot, and the bot reads the steps left and finishes with its own browser tools.
- A bot that hands work to another bot can send files with it (`bot_send` takes `files`): the other bot gets its own
  copies under `received/<sender>/` in its conversation folder and reads where they are. The bot answering can send
  files back with its answer (`reply_files`), and the asking bot reads where the copies landed.
- A daily spending limit for the whole server beside the monthly one (Settings → Usage), and daily and monthly limits
  for each bot in its advanced settings, with what it spent today and this month. A turn that would go past one does
  not start and says which limit stopped it and where to change it. Another bot cannot set a bot's limits.
- A bot, a group or every bot at once can be paused from the sidebar's menus. A paused bot's running work stops and
  says why; what the person writes to it waits and is answered once it is resumed; its routines are skipped with the
  reason; and another bot that asks it for help is told it is paused. A pause mark shows on its avatar and a bar above
  the message box resumes it. Only admins pause a group or every bot.
- A bot that finds a better way to do a skill's task while working for someone who may not change that skill now
  suggests the change to the skill's owner instead of changing it for every bot that has it. The suggestion carries
  the bot's reason; Settings → Skills shows it as a comparison with the skill as it is now, to accept or reject, and
  the Today page counts the ones waiting. A newer suggestion from the same bot for the same person replaces the one
  still waiting. Someone who may only talk with a bot can suggest changes too, but still cannot add skills to it.
- Skills count how often bots read them, and the skills list shows the count.
- Bots can take an object avatar (Bot settings → Object): a mug, a lightbulb, a sprout, a game controller, a
  barbell, a speech bubble or a watering can with eyes, in the bot's colour. The desktop and web app draw it with
  volume; while the window has the focus it breathes, blinks and looks at the pointer, and it shows what the bot is
  doing: dots while it thinks, ribbons while it writes or reads a page, an exclamation mark when it needs someone.
  Avatars off screen rest, and the system's reduced motion setting stops them. The phone app shows the plain plush
  for these bots for now.

### Changed

- Yumak Bot is now Leaf Bot. The repository is `esmworks/leafbot`, the contact address `info@leafbot.app`, the
  images `ghcr.io/esmworks/leafbot-server` and `-computer`, and the app ID `com.esmworks.leafbot` on the desktop and
  phones. What an earlier installation set up keeps working:
  - The desktop app is a new app under the new ID, so an installed Yumak Bot does not update itself to it: install
    Leaf Bot from the release. On first start it takes over Yumak Bot's bots, chats and settings (quit Yumak Bot
    first; it says so if it is still open). A desktop app that was connected to a server elsewhere starts with its
    own server instead, since the saved key was sealed for the old app; connect it to that server again.
  - The phone apps are new apps too. A server that sends iPhone notifications needs the new app ID under its push
    settings; until then they reach the old app only.
  - `sudo yumakbot update` on a server installed with `docker/install.sh` carries the settings over: the `.env` keys
    get their new names, and the project, database, network bridge and Tailscale names stay as they were, so the
    same volumes, data and address are found. The command is `leafbot` from then on; `yumakbot` stays as a link.
  - A server set up by hand keeps running with its old `YUMAKBOT_*` settings, which are read wherever the new
    `LEAFBOT_*` name is not set. Before renaming the keys in its `.env`, add `COMPOSE_PROJECT_NAME=yumakbot`,
    `POSTGRES_USER=yumakbot`, `POSTGRES_DB=yumakbot` and `LEAFBOT_BRIDGE=yumakbot0`, or Docker starts it with new,
    empty volumes. A reverse proxy may keep sending `X-Yumakbot-Proxy`.
  - Signed-in browsers and phones stay signed in, `yumakbot://` links still open the desktop app, settings saved in
    the browser come along, and backups and bot files made with Yumak Bot can still be restored and imported. The
    app's own tools are named `mcp__leafbot__*`; permission rules, tool limits, routines and chat history are
    rewritten to the new name, also in a restored older backup.

- Someone with no account here (a member of a Discord server, say) can no longer have a bot sign in to a site: the
  vault's password, its two-step codes and codes mailed to the bot are not offered in their turns, since those tools
  run without a card.

- A skill a bot saves for someone belongs to that person, who may then change or delete it like one they wrote.
  Before, only the admins could.

### Fixed

- A bot whose model the provider retired, or whose model name it does not know, goes on with the backup model when
  one is set, and the chat says to pick another model for the bot. Before, each message ended with the provider's
  error.
- A one-time routine whose run failed for a passing reason (a spent usage limit, a busy or unreachable provider) is
  tried again, as a repeating routine is. A scheduled run that a server stop cut short is tried again too, once and
  a little later, when it had let through no step that changes something.
- A WhatsApp message that first arrives undecryptable reaches the bot once WhatsApp gets it again from the sender's
  phone. It was taken for a repeat of the empty stand-in and dropped.

## 0.6.1 — 2026-11-20

### Added

- The bots' browsers can leave through Cloudflare WARP instead of the server's own address, which some sites behind
  bot guards refuse for being a data centre's before their page even loads. An optional `warp` service in
  `docker/compose.yml` (`YUMAKBOT_WARP=1` with the installer) and `YUMAKBOT_EGRESS_PROXY` turn it on; the person's own
  computer still comes first when it is connected. Addresses are checked on the server as before, the operator's
  local hosts go straight, and while the proxy cannot be reached the browsers leave from the server again.
- The iPhone app gets notifications while it is closed. It hands its device token to the server with the phone's
  notification level, muted bots and language, asks for permission once after sign-in, and opens the conversation of
  a tapped notification. Settings → General has a Notifications card with the level, the phone's permission, a test
  notification and a hint when the server has no Apple key. While the app is open, only the conversation on screen
  stays quiet.
- Settings → Import and backup reads Grok Bot marketplace links (`x.ai/bot/marketplace/bots/…`) as well as share
  links, and takes the bot from the page's add button.

### Fixed

- The bots' desktop browser no longer shows bot guards such as Akamai two marks of a program: started with the
  DevTools pipe, Chromium reported `navigator.webdriver` as true and sent an experimental TLS extension Chrome does
  not, and these sites cut the page's requests after the first one.
- The bots' desktop browser speaks the bot's language: menus in Turkish for a Turkish bot, and pages asked for in its
  language instead of always in English. The "unsupported command-line flag" bar no longer covers every page.
- The bots' desktop browser draws WebGL again, in software, as the desktop has no graphics card. Pages got no WebGL
  at all, and a browser without it is one bot guards such as Cloudflare's check rarely let through.
- The bots' desktop browser is Google Chrome instead of Debian's Chromium. Sites behind bot guards see the browser's
  brand and trust the one most people use. Chrome opens the bots' existing profiles; a profile Chrome has opened may
  not open in the older Chromium again.
- Bot guards such as Cloudflare's check let the bots' desktop browser through while a bot drives it. The server drove
  it with a Playwright that turns on a DevTools domain pages can detect, and ran its page reads in the page's own world,
  where the page can watch them; the desktop's browser is now driven by `patchright-core`, the same Playwright without
  that domain and with its scripts in an isolated world. Without that domain the desktop pages' console messages no
  longer reach the bot. The passkey wall, which left a binding on every page, is no longer put into the
  desktop's browser; a passkey window shows on the desktop's screen instead.
- A connection whose refresh token the service refuses for good asks for a new sign-in. X refuses a spent token with
  `invalid_request` rather than `invalid_grant`, so the connection stayed connected while every call failed, and
  signing in again failed on the kept token. Any OAuth error other than a server error, a pause or a rate limit now
  signs the connection out, and a sign-in the person starts drops a refused token.
- Bold text followed by a suffix after a quoted word, such as `**"Yenile"**ye`, shows in bold in the desktop and
  mobile apps instead of keeping its asterisks.

## 0.6.0 — 2026-11-19

### Added

- Rooms keep meeting minutes. When a talk starts after a quiet spell, the room asks on a card whether it is a meeting
  (yes, no, always in this room, never ask here); a meeting can also be started from the room's menu. It ends from the
  header or after 30 quiet minutes, and the minutes (summary, decisions, tasks with who took them on and by when, open
  questions) are written with one answer of a member's model, a long meeting in parts. The person reads, fixes and
  approves them, and picks which bots are to know: each gets a note in memory with the decisions and the tasks it took
  on first, so it knows them in every conversation, not only in the room. A note for a bot the person may only talk
  with waits for the bot's owner. Minutes can be copied or downloaded as Markdown, and are kept encrypted.
- Tasks in approved minutes that have a day can be reminded of. On that day, at a time the person picks, the bot that
  took the task on looks at where it stands and tells the person, in the conversation where they talk; a person's
  task is brought up by the first bot of the room the person may change. Each reminder is a one-time routine among
  the bot's routines, and reminders that already ran are cleared away as new ones are set.
- Settings → Import and backup reads a Grok Bot share link (`x.ai/bot/…`): it shows the bot's name, who shared it
  and its description, opens the page to add the bot in Grok Bot and copies export instructions for that one bot.
  The share page carries no more than that, so the bot itself still arrives in the import file.
- The Grok Bot export instructions carry each bot's skills with their full text, its shape, and its integrations as
  notes to set up again. The import preview shows each new skill's text and says which ones stay off because their
  text hides something.
- Bots on API keys run shell commands in the same OS sandbox as Claude bots: kept to the bot's folders, with an
  environment of their own, the internet only when the bot has it on, and public addresses only. A bot with a
  desktop keeps running its commands there.
- Bots on API keys read web pages (main text, headings and links) and, when the server's environment names a
  SearXNG with `WEB_SEARCH_URL`, search the web. Both ask under the same names as a Claude bot's steps, so the
  same "always allow" and "always ask" rules and the same cards apply.
- Opening a page whose address imitates a site the person uses (look-alike letters such as "faceb00k", one letter
  off, or the name inside another domain such as "facebook.com.giris.io") asks at every level, full access too,
  and the card warns which site it looks like. Such a card offers no "always allow". The sites measured against are
  often copied ones (mail, social media, stores, payments, banks, e-Devlet), the sites the person keeps a sign-in
  for, and the domains they wrote.
- A routine can read WhatsApp: the chats people start with the linked account, and groups the person picks. A chat's
  new messages reach the routine as outside text a couple of minutes after it goes quiet, with its last messages for
  context, each chat in a conversation of its own. Messages are kept encrypted for 30 days; codes, passwords and
  sign-in links are never kept, only a line saying one was left out. A bot drafts a reply or a WhatsApp Status post
  on a card, and nothing is sent until the person approves it. Groups are only read, and only the person who linked
  WhatsApp can have a routine read it. A bot can also set a routine to follow a group by its name or read people's
  chats when asked in a conversation; it asks the person on a card first, at every level.

### Changed

- A desktop's browser that leaves through the service's own SOCKS skips the per-request
  private-network guard: the SOCKS refuses private addresses itself, and the guard only cost that
  browser its HTTP cache and its service workers. A browser without that SOCKS keeps the guard —
  without it nothing would keep the pages it opens away from the server's private network.
- A bot check that stays now gets its own wait, one click on a Turnstile checkbox, and one more
  wait before the page goes to a person. The single click is the one gesture a person makes at a
  Turnstile and the check stays the one that decides; a second click, a reload or a puzzle is the
  person's step (wall note updated in both languages).
- The bots' Linux desktops run Google's own Chrome build instead of the distro's Chromium. Bot checks
  like Cloudflare's read the open-source build's missing browser pieces as suspicious; running the
  real browser is the honest fix — no imitating, no solving. Profiles keep their old path
  (~/.config/chromium), so logins and cookies survive the switch.
- Bots work by themselves by default ("Full access"). A new bot, one a manager creates and one imported without a
  level start there; the person can still pick "Ask" or "Read only". Only these still stop for the person, at every
  level: their "always ask" rules, a page that imitates a site they use, filling a saved card, a sign-in, and the
  commands no level lets through.
- The "review" level, a small model judging each step, is retired. A bot still saved with it works at full access and
  shows as such. It handed the person more cards than it spared them, and every step waited on a model call.
- Text the bot read from someone else (a page, a mail, a webhook, another bot) no longer lowers its level. That text
  still reaches the bot marked as outside data, and the steps above still ask.
- "Always allow" on a card puts the bot on full access and lets through the cards it is waiting on, instead of
  keeping a narrow rule for that one step. The suggestion for a bot whose cards the person nearly always allows now
  offers full access.
- A bot's memory changes take effect at once, wherever they come from: a routine, another bot, a turn that read
  outside text, the background memory review, the shared memory, a place's notes, a pinned note or one the person
  wrote. A stopped or failed turn keeps what it wrote. Every change still shows in the memory screen and its history,
  where the person can change or delete it. Only a change to a bot's notes asked by someone who may not change that
  bot still waits for someone who may; the background review skips such changes, and leaves the notes the person
  wrote or pinned alone, instead of queuing them.

### Fixed

- The routine pre-check runs on the bot's own account, as its run does. It used to be Claude alone, so a routine of
  a bot on API keys ran unchecked on a server with no Claude sign-in.
- A command that only reads the bot's own folders goes without a card on its desktop too, and as a whole line:
  readers chained with `;` or `&&`, piped into readers, with errors thrown away and folders named in variables set on
  the line (`B=…; ls $B | grep …`). Such a line opened a card. The bot's
  other conversations and its desktop's home still ask.
- The desktop app connects again as the bots' way out to the web after the server restarts. A restart used to end
  the connection the way a takeover by another computer does, and the app stayed away until it was opened again.

## 0.5.0 — 2026-11-19

### People

- Several people use one server, each with their own username, password and devices. The owner installed it; admins
  look after it with them; members use the bots shared with them. Settings → People adds, renames, disables and
  removes people, gives new passwords and changes roles; only the owner handles admins. A change counts at once and a
  disabled person is signed out everywhere.
- A bot belongs to the person who made it. Its owner or an admin shares it with everyone or some people, to talk with
  or to change; a bot not shared with someone does not show for them. What existed before stays the owner's, unshared.
- Conversations are their person's own: nobody else sees them, admins included, and live updates and notifications go
  only to them. A bot's own work (tickets, requests between bots) shows to those who may change the bot.
- Each person has their own profile, language and notes about themselves; a bot reads those of the person it works
  for. A change to a bot's own notes asked for by someone who may only talk with the bot waits for its owner.
- Connections and vault sign-ins are the team's or a person's own. A bot uses the team's and those of the person it
  works for; only admins set up or change the team's.
- Routines, tickets, chat apps and bot-to-bot requests work for the person who set them up, and reach no further than
  that person may. A routine changed by someone else works for them from then on, and its runs and reports stay in
  the conversations of the person it works for.
- Only admins offer their computer as the bots' way out to the web, and each person's connection limit counts apart.
- A removed person's conversations, notes, connections and sign-ins go with them; the bots they made pass to the owner.

### Slack

- The server can have one Slack app, set up by an admin under Settings → Chat apps from the manifest shown there. It
  connects over Socket Mode, so the server needs no public address.
- Each person links their Slack account with a code from Profile; nobody else's requests run. A direct message goes
  to their own conversation with the bot they last named (`Sales: …`) or the default bot.
- Mentioning the app in a channel starts a team conversation: everyone who may talk with the bot sees it in the app,
  and it stays when the person who started it leaves. It uses only what the team shares (team connections and
  sign-ins, the bot's own notes), never one person's profile, notes, apps or sign-ins, and it hands no work to other
  bots and makes no routines. A bot shared with nobody does not answer in channels.
- Once the bot is in a Slack thread, later lines there reach it without a mention. Called into a thread that was going
  on, it reads up to its last 30 lines as others' words.
- A card in a team conversation is answered only by the person who asked or by someone who may change the bot, in
  Slack and in the app alike. Replies, files and 👀/✅ marks go back to Slack.
- A routine can post its report to a Slack channel; such a routine runs as a team conversation.

### Discord

- The server can have one Discord bot, set up by an admin under Settings → Chat apps with the bot's token from the
  developer portal. It connects over Discord's Gateway, so the server needs no public address. The card gives the link
  that adds the bot to a Discord server.
- Anyone in a Discord server the bot is in can mention it in a channel, as for a community's help desk; for each server
  an admin can allow only the members of chosen roles. A direct message gets one fixed answer: mention the bot in a
  server's channel.
- A mention starts a team conversation with the bot chosen for Discord, which everyone who may talk with that bot sees
  in the app; a reply to the bot's post goes on with it. A new conversation reads the channel's last messages from the
  15 minutes before it, or the message it replies to, as others' words.
- People in Discord have no account here. Their requests act for the server's owner but use only what the team
  shares, may do no more with the bots than talk with them, and leave the "always allow" rules aside. Reading the
  team's apps, mail, tables or the web, and every step that changes something, waits for a card, whatever the bot's
  level; they start no board work and save no skills. A bot shared with nobody does not answer in Discord.
- A step's card is answered in the app by those who may change the bot. In a server with chosen roles, the member who
  asked can also press its buttons in Discord; a question's card is theirs to answer there in any server. Nobody else
  presses them, and "always allow" is not offered there.
- "Working on it…" with a Stop button shows until the first answer takes its place; 👀 becomes ✅, ❌ or ⏹️. Only the
  person who asked stops it, with the button or a reply `stop`. One person has at most two requests under way, and at
  most 20 wait in all. What is written in the app in such a conversation is posted to the channel with the writer's
  name.
- Answers are split at Discord's 2,000 characters; files go both ways, up to 10 MB to Discord. A post notifies only the
  people it names, never a role, `@everyone` or `@here`.

### Connections

- Gmail asks for the read and compose scopes as well, as its setup guide does. A Gmail account connected before keeps
  its old grant until it is signed out and signed in again; with your own Google app, add the `gmail.readonly` and
  `gmail.compose` scopes to its consent screen first.
- Gmail's MCP server lists no tool that sends mail or changes drafts and labels, so the server adds its own, under
  the same names and inputs, and runs them through the Gmail API with the connection's sign-in (the compose and
  modify scopes allow it): `send_message` (attachments, inline pictures, the signature, sending in a conversation,
  sending a draft as it is), `reply` and reply-all, `forward` with the mail's files, `update_draft` (the draft's files
  stay unless new ones are given), `delete_draft`, `update_label` and `delete_label`. A tool the server lists itself
  is used instead. Each always counts as a change, and whatever Google refuses comes back with its own words and the
  step it refused. The Gmail API has to be turned on in the Google Cloud project. A connection gets the tools on its
  next refresh.
- A mail a bot asks to send, reply, forward or keep as a draft through a connected app shows as the mail itself: who
  gets it, the subject, the body, the attachments and whether the signature is added, with Send and Cancel; "always
  allow" and "never" sit in the menu next to Send. A formatted body is drawn without scripts or outside pictures. Once
  answered the card folds to one line that opens the mail again. The card is white, as the mail will look; for a Gmail
  connection it shows the address the mail goes from and, when the signature is added, the signature itself under the
  text, its pictures fetched by the server and put inside it so the page still loads nothing from outside.

### Browser

- A bot can read the requests each tab of its browser made and what the page's scripts logged, uncaught errors
  included, to find out why a page does not work. Only the method, address, status, type and time of a request are
  kept, never its body or headers; address parameters that may carry a secret and tokens printed to the console are
  hidden.

### Long conversations

- Bots on other providers no longer send the last 160 messages whatever their size. A request is measured against the
  model's context window: past 80% of it, the older part is folded once into a summary written by the bot's own model
  and kept with the conversation, so later turns reuse it. When no summary can be written, the newest of those
  messages stand in word for word and the bot is told the rest is missing. Tool results are cut to what the window
  allows, and a conversation that still overflows goes on in a new session that carries the summary.
- Claude bots fold the conversation at 200k tokens instead of near the model's whole window, which for a
  million-token model meant resending the whole conversation every turn. The size can be chosen in Settings → Model
  (100k to 1M, or Claude's own value).
- Bots are told to look up exact wording, numbers and earlier decisions in past conversations instead of guessing, and
  a message cut short when a conversation moves to a new session can be read whole.

### Teamwork

- A subagent's card says what it is doing now, how long it has worked, and, once it ends, what it handed back.
- A bot stopping one request it sent stops only that request and the work its target handed on for it; other requests
  between the same two bots go on.
- Stopping a room also stops the work its members gave other bots, as stopping a conversation does; so does deleting
  a conversation.
- A person's request cut short by a server restart can be run again from its note; the bot first looks at what the cut
  attempt already did instead of repeating it.
- A request between bots left open by a server stop ends at the next start: with its target's answer when that turn
  had ended, otherwise as cut short, so the answers to the other requests of the same turn reach their sender.
- A stop waits a moment for the turns it stopped to end, so a request to another bot made just as the stop came is
  stopped too.

### Approvals

- "Always allow" on a card for a line of commands run in a row or piped (`cd repo && gh run list | head -40`) keeps a
  rule for each command in it (`Bash(gh run:*)`), not one for the whole line that the next day's folder or commit
  would never match again. Such a line runs without a card when every command in it is covered; moving to a folder,
  `echo` and filtering what is piped in need no rule. A line with a substitution, a variable or a redirect into a file
  is kept whole, as before.
- An "always ask" or block rule for a command also covers it inside such a line (`cd repo && git push`).
- The auto review takes a routine's goal as asking for the reads it needs: "look at the commits that landed on main"
  covers reading their diffs, without the routine naming each commit.
- A card in a chat app shows the step itself, as the app does under "What?": the command, file, address or what a
  connected app is sent, cut to a few lines. Keys, tokens and passwords in it are masked, since the chat app's server
  keeps what is posted there.
- "Always allow" on a step that carries a key or password counts for this time only, so the secret is not kept in a
  rule and listed in the settings.
- "Never allow" on a card blocks that step for that bot, as narrow as "always allow" keeps one (`Bash(git push:*)`),
  rather than the whole tool for every bot.
- When a connection moves to another server or is removed, the "always allow" rules for its tools go with it: another
  server's tool of the same name may do something else. "Always ask" and block rules stay.

### Settings

- The default model and effort for Claude bots are each picked from a drop-down, in Settings → Model and in the
  first setup, instead of a list of cards and a row of buttons that took up most of the screen.

### Models

- A bot's settings pick a connection (Claude or any provider connected under Settings → Connection), then a model by
  its name, newest first, then how hard it thinks, offering only the levels that model takes; a model that does not
  think shows no such choice.
- Model names and release dates come from the public models.dev catalog, downloaded once a day. A model released after
  this version shows up from it too, and runs with the catalog's limits and price. Without the catalog the lists are
  the built-in ones. `YUMAKBOT_MODEL_CATALOG_URL=off` turns it off.

### Bots' computer

- Git, and pnpm and yarn through corepack, are on the bots' desktops, so a bot can clone a repository, install and
  build it there.
- Git reaches GitHub through the computer service, which adds the API key saved for `https://github.com` that the bot
  may use (a fine-grained token limits it to chosen repositories). The key never enters the desktop: no command, file
  or setting there shows it. A change to the key reaches running desktops at once; a bot with the internet off gets
  none.
- A push to a repository's default branch is refused there, whatever the bot was told: work reaches it through a pull
  request a person merges.

### Keys, sign-ins and payment cards

- API keys belong to a person or to the team; a member can no longer change the team's keys, and a card asking for a
  key offers the saved key of the same kind.
- Sign-ins can come from 1Password, Bitwarden or Proton Pass without copying passwords into the vault. Their secrets
  reach the programs only through the environment, and a manager that cannot be read does not hold up the others.
- Payment cards are sealed like passwords. The server fills them into a checkout's fields, only in a turn the card's
  owner started, and asks before the first use on each site, frames of other sites included. Card numbers and codes
  are masked in everything the bot reads.
- A passkey prompt is refused at once instead of leaving the page waiting.
- Sign-ins and keys can be imported from a browser's export or an `.env` file, and a one-time code set up from a QR
  picture. A secret pasted into the chat is flagged, and replies going out to chat apps are masked by the shape of a
  secret.
- A deleted bot leaves the bot lists of vault entries.

### Memory

- A bot looks back at a conversation every few turns a person started (off, 10, 20 or 40; 20 by default) and keeps
  the lasting facts. Only a bot's own notes from a person's own chat with no outside text are saved straight away;
  shared, place, pinned or hand-written notes, and anything near outside text, wait for the person. Conversations
  that existed before start from their latest message. Those who look after the server turn it on or off.
- Notes can belong to a Slack or Discord channel or a room; they reach only the turns there, within a limit per place,
  and go with a deleted room.
- A pinned note always goes into the prompt first, within its own limit; a bot's change to a pinned note asks the
  person.
- Deleting a note removes its words from the history too, and purging a bot removes its memory history.
- An edit made on an old version of a note is refused instead of writing over newer words.
- What a stopped or failed turn changed in memory is taken back and waits for the person to accept it.
- On the web and the phone notes are edited in place, pinned, searched and their history read.

### Approvals and the review

- A person who answers the bot's proposal with "ok, do it" no longer gets a card for the step it proposed: in their
  own turn a step that sends goes to the review, which reads the bot's last reply as what the answer agreed to but may
  quote only the person's words.
- A step the review lets through no longer writes a notice with its whole input into the chat; the bot says what it
  did, and the step is kept in the record. The list of steps a bot was let take left its side panel, since nothing in
  it waits on the person.
- Looking something up on the web after outside text was read goes to the review, which knows the text was read and
  holds anything that sends data out; commands and API calls still ask.
- A scheduled routine counts as the person's request, so a page read on the way no longer puts every bot down the
  chain on a card per step. A run that a mail, a webhook or a watched page started stays on cards.
- Handing work to another of the person's bots no longer asks, unless the other bot may do more than the sender.

### Chat apps

- Requests in progress are kept across a server restart, which tells the person to write again instead of leaving
  "typing…" or a reaction hanging; requests whose turn is still queued go on when it resumes.
- A send the chat app refuses for too many requests is tried again a few times within a capped wait, and every call to
  a chat app has a time limit.
- The Telegram card under Settings → Chat apps says when the person blocked the bot, until they unblock it.
- Slack and Discord post a thread's replies in order before marking the request done, and mark it failed when a reply
  could not be delivered. In Discord, a reply chain's context holds only the lines of that chain.
- WhatsApp sends again after a dropped connection without the message arriving twice, reads messages held while the
  device was away (newer than the last one read and under a day old), links a reply to the message it answers, and
  marks quoted text not known here as outside text. The guard against a bot answering itself in the self chat counts
  only what goes to the bot, lets commands and card answers through, and says when it held a message.
- The bot is told which files did not arrive, and the person is told when a turn ended without a reply.

### Routines

- Each due routine runs on its own: one that cannot start is recorded as a failed run and its slot moves on, so the
  others still run, and a run whose turn cannot be queued ends with an error at once instead of blocking later runs.
- Watched pages and app checks are read on the side, at most four at a time, so a slow page does not hold up the
  timer.
- Schedules that run more often than every five minutes are refused, and a bot has at most 50 routines.
- Runs skipped while an earlier one is still going are counted on one line, and a retry after a passing fault keeps
  the schedule going from the slot it stands in for.

### Browser and connected apps

- A long page's outline is read whole and handed out by part, by words or by section, so the end of a long list can
  be reached and every reference on it stays valid.
- Files a site downloads are kept in the conversation's folder and reported to the bot, within limits of size, number
  and time; a slow download no longer holds up the next steps.
- A reference to an element the page removed fails at once with a clear message, without a card. A click under a
  visible dialog or banner is refused and names what is in the way; a see-through layer or the field's own label is
  still clicked through. Pages still drawing placeholder boxes get a short wait before they are read.
- The bot can wait for a text to go away or the address to change, and drag one element onto another. At most ten
  tabs stay open; extra tabs a site opens are closed and reported, as is a tab the site closes itself.
- Each connected app has a few clients at once, so a long call or a question waiting for the person no longer holds up
  the other calls; only token renewals and sign-ins run one at a time. A refused token is renewed once.
- An app that answers that a permission is missing keeps its connection; its card offers Sign in, which asks for the
  missing permission. An app added as needing no sign-in becomes one that signs in when it asks for it.
- Connected apps' tool lists are read again every six hours and when the app says they changed, without dropping a
  working connection over a passing failure; a connection is tried again once after a passing fault.
- Signing out of or removing a connection revokes its tokens with the service, unless another connection signs in
  through the same registered app. Secrets in the errors a service sends back are masked, cut-off ones included.

### Plan usage

- A ring beside a Claude bot's chat shows how much of the fuller of the five-hour and weekly windows is used, and a
  click lists every window with its reset, so people see the limit coming before a turn is refused. Everyone signed in
  sees it, since they all spend the same plan.
- The windows are read from every rate-limit event, so a bot signed in with a token from `claude setup-token` shows
  them too. Settings shows them with a line for the pace; the amber "ahead of time" colour needs at least half a window
  used.
- Settings sets how many turns run at once.

### Reliability

- A turn ends when the same tool call fails the same way five times, with a warning at three.
- A Claude bot falls back to its backup model when the Claude sign-in fails and on server errors (500, 502, 504).
- Large pictures are made smaller before they reach a model.
- An answer written together with quick replies is kept on Claude bots too, instead of being replaced by the short
  line after them.
- A subagent the bot starts shows as a card in the chat, and its text stays out of the reply.
- An attachment that fails to upload is tried once more when the failure looks passing, then stays in the message box
  with a retry button; sending waits until it is up or taken off. The web shows upload progress.
- Admins see what storage holds: each bot's folders, its largest conversations, the groups' folders and attachments
  waiting to be sent.
- The desktop app asks before quitting while bots are working.

### Look

- A new icon: a green plush coming in from the corner of a dark green tile, with oval eyes that lean with its head, on
  the desktop, the web, the phone (Android's adaptive and themed icons included) and the menu bar. The first screens
  greet with the same plush, and their accent and the ready-made bots' colour turn green.
- The plush art's MIT notice is in NOTICE, which the desktop app and the server image now ship with LICENSE.

### Server setup

- A hosting panel such as Dokploy routes its domain to a small `gateway` service (`COMPOSE_PROFILES=gateway`) instead
  of the server, so the server stays off the panel's shared network and goes out only through the firewalled bridge.
- The name of the bridge the containers reach the internet through can be changed (`YUMAKBOT_BRIDGE`), so two
  installations can run on one host.
- `docker/README.md` explains the egress firewall for an installation run from a panel and how to keep it across
  reboots; `docker/.env.example` lists the keys the VPS compose file reads.

## 0.4.1 — 2026-11-18

### Safety

- Outside text now counts from the step a run reads it, not only when it started the run: a page, a search, an API's
  answer, a mail, a host a command reached, or (with nobody watching) a ticket or a table marks the run from there on,
  in both engines. The mark goes with the reply, a request to another bot and its answer, a conversation the bot
  opens and the session it resumes. Work nobody asked for (a mail, a webhook, a watched page) asks for every change;
  work that goes back to the person's own message keeps the bot's level and "always allow" rules, the reviewer is told
  outside text was read, and steps that can reach another host (a page, the browser, an API call, a network command,
  inline interpreter code) still ask.
- A connected app's answer is no longer counted as outside text, and an app's own read-only tools run without a card
  in handed-over runs; app tools that take an address still count as reading the web.
- "Always allow" covers only the bot that asked and only as wide as the step: a command and its subcommand, a file's
  folder, a page's site. A command rule no longer covers another command chained after it.
- Permission rules can carry an amount limit on a field: an allow rule covers a call only while the value is readable
  and within the limit, an ask or block rule once it is above or cannot be read.
- Every step that goes through is kept for 90 days with what let it (a card, a rule, the bot's level or the reviewer),
  shown in the bot's panel and downloadable as a spreadsheet. From the last 30 days of answers the panel suggests an
  "always allow" for steps the person always allowed, or the review for a bot whose cards they nearly always allowed.
- A step the person just refused is refused again without a card until they write something new. Answers on a bot's
  question cards count as the person's words for the review.
- Bots the person creates, a manager creates or an import brings start on the auto review instead of asking for
  everything. A manager changing another bot's instructions, section, engine, model or skills asks the person.
- Instructions can be kept in a public document owned elsewhere: it is read once a day or on request, and a change
  reaches the bot only after the person accepts the diff in the bot's panel.
- Memory changes from a run that read outside text are only proposed; shared memory and another bot's notes change
  after a card. Messages forwarded on Telegram or WhatsApp reach the bot as outside data.
- The safety floor also refuses removing a top-level or home folder, deleting from one with find, recursive chmod or
  chown on one, writing over device mapper disks, and such commands inside inline interpreter code.
- Saved passwords and two-step codes go only into a password, username or code field of the saved site over https,
  in a form that posts only to that site; they are hidden from every text a browser step returns and no screenshot is
  taken while one shows. Clicks and keys that send a form ask the person whatever the bot said, and a form submission
  not approved as sending is cancelled.
- Vault secrets and API keys are sealed together with their row and site or origin, so a value moved or redirected in
  the database no longer opens; older values are bound once on first use. The mail relay's secret is sealed too.
- Backups and new password hashes use stronger scrypt settings; older ones still work and passwords are hashed again
  on the next sign-in. A restore checks entry sizes, the unpacked total and the free disk space.
- Sign-in is decided by the route a request matched, so a percent-escaped path no longer skips it. Sign-in tries are
  counted before the password check, per /64 on IPv6, with a daily ceiling across all addresses that slows guesses
  without shutting the owner out; wrong access keys are limited too. A password change signs out every other device.
- Link fetches (skills, plugins, API specs, watched pages) check every address a name resolves to and connect only to
  those, refuse more wrapped and reserved private ranges, and stop reading at the size limit. The bots' browser goes
  through the checking proxy on the person's own computer too, and service workers are blocked in it.
- Commands of a bot with internet go out through a proxy that connects to the address it checked.
- A page in a conversation or a connected app asks before opening a link by itself; on the phone every such link asks.
- The server sends Strict-Transport-Security when reached over HTTPS.

### Server

- The bots' containers can no longer reach services on the host itself, and more reserved and NAT64 ranges are
  blocked on the way out.
- PostgreSQL, Caddy, cloudflared and Tailscale images are pinned to a version and digest, `YUMAKBOT_VERSION` is
  required in the compose file, and the Tailscale container drops every capability and runs on a read-only root.
- The Cloudflare guide shows how to send the proxy header so sign-in limits count each visitor, and the sandbox guide
  explains each relaxed container setting.
- Chat formatting no longer loops for ever (freezing the server) on a reply that contains its own markers.
- katex, esbuild and minimatch were moved past their security advisories.

### Apps

- The desktop app compares the server's whole origin before letting a page navigate, gives the microphone and
  clipboard only to the top frame, and ships with Electron's fuses set.
- The phone app uses plain http only for this device, the local network and Tailscale; an internet server is reached
  over https, and an `http://` internet address is used only after a warning.
- A card asked while a reply is streaming shows below the text written before it, on the desktop and the phone. A card
  waiting in an exchange between bots shows at the end of the conversation.
- Settings → Connection offers to move existing bots to the AI new bots start with. A bot that changes engine drops its
  room sessions too, and its routines' models are cleared.

### Fixes

- A reply the provider cut off is retried once on the same model before the backup model, when nothing was changed
  yet.
- "Retry" no longer refuses almost every failed turn: row times are compared in the database, which also fixes a
  forked conversation missing its chosen message, a skipped message between pages and a repeated search result.
- An answer written together with quick replies is kept instead of being replaced by the closing line, and an error
  whose request was run again is hidden.

### Releases

- The release workflow runs in three jobs, so only the jobs that create the draft and attach the files hold a writing
  token and none of them runs project code. Third-party actions are pinned to a commit. Windows signing is used when a
  certificate is set up.

## 0.4.0 — 2026-11-17

### Safety

- A routine started by outside text (a mail, a webhook's body, a watched page, an app's new answer) asks before every
  change: "always allow" rules do not count, the auto review is skipped, and only reads and talking to the person go
  without a card. Reaching the web asks too, since an address could carry away what the bot read. The card says what
  started the run and offers no "always allow". The same holds for a later turn that reads that text: a resumed
  session, a routine report read in the main chat, or a report carried into the next run. A read-only bot stays
  read-only, and runs the person starts are as before.
- A mail or watched change that arrives while its routine is still running waits and starts once the run ends, instead
  of being dropped; pausing the routine drops what waited.
- Block a tool outright: a block rule refuses the call in every mode, before any other rule, review or card, and tells
  the bot so. A card's "Never allow" adds one; blocks are listed with the other rules under Settings → Permissions.
- Encrypt conversations in the database (Settings → Vault): message text, turn prompts, memory notes, bot-to-bot
  requests, mail and ticket text are stored with AES-256-GCM under a key derived from the vault key, which lives in the
  data folder and never in the database. Turning it on or off converts what is stored in the background; a value that
  cannot be opened is never written over and is counted in the settings. Text search is slower while it is on.

### Board

- A board of tickets the person and the bots work from, with a status, priority, assignee and comments. Assigning a
  ticket to a bot starts it in a conversation of the ticket's own; its reply comes back as a comment and the ticket
  moves to review, where a comment from the person sends it back. Bots list, read, open and update tickets; a ticket a
  bot opens while working on one waits for the person instead of starting its assignee.
- The board fills the window with five columns, cards show the priority, the bot, a line of the description and
  whether the bot is working on it, and a ticket opens beside the columns. Cards are dragged between columns and into
  any place in a column; a move that would start a bot asks first. The board can be searched and filtered.

### Bots

- Bots get mail addresses of their own under a domain set in Settings → Chat apps. The server runs no mail server: a
  relay (Cloudflare Email Routing, a provider's inbound webhook) posts each message with a secret, and attachments go
  to the bot's folder. Mail starts a bot only through routines marked to run on mail, filtered by sender, subject or
  text, and is outside data wherever the bot reads it.
- API keys a bot never sees: a key is saved by name for one address and sealed with the vault key. A bot asks for one
  on a card that shows where it will go and names it in `api_request`; the server adds the key to requests for that
  address alone, does not follow redirects and takes the key out of the response. Keys are listed in the vault.
- An OpenAPI JSON document, added by address or pasted, lets a bot list its operations and call one by its id; the
  request goes only to that API, through the saved key the person picked, and operations that change something ask.
- Teach a bot a task by showing it: start teach mode in the bot's browser, do the task once, and get a skill back to
  look over and save. Typing into password fields is never recorded.
- A bot can keep tables with typed columns; the person reads, corrects and downloads them from the bot's panel.

### Connections

- Install a plugin from its address, in the shared format or as a Claude Code plugin: its remote MCP servers and
  skills are listed, the person picks what goes in, and they install as ordinary connections and switched-off skills.
  Parts that would run the plugin's own code on the server (hooks, local servers) are never installed and are named.
- A routine's webhook takes GitHub events: calls signed with `X-Hub-Signature-256` are checked against the routine's
  secret, the filter reads the event kind as `event`, and GitHub's set-up ping only answers. The routine dialog walks
  through adding the webhook on GitHub.
- Settings → AI services sets three services of the person's own: memory search by meaning through an
  OpenAI-compatible embedding service (such as bge-m3 on Ollama), speech to text through a Whisper server and reading
  aloud through a Kokoro server. Plain http is accepted only on the private network. When left empty, the
  `AI_EMBEDDINGS_*`, `STT_*` and `TTS_*` environment variables apply.

### Memory

- A search finds notes near the query in meaning, with word matches ranked higher; it falls back to words while the
  embedding service is down.
- A note keeps the conversation it was written in and the page the fact came from, with anything that could sign
  someone in taken out of the address.

### Routines

- A routine keeps the instructions it has had; an older one can be compared with the current text and brought back.
- An instruction that names an app the bot cannot use yet says so, with a way to connect it.

### Chat

- Pages a bot builds can be shared by link with someone without an account, served sandboxed as the app frames them;
  links are turned off from the page card or the vault. The page card also opens the page with the print dialog, to
  save it as a PDF.
- Voice notes from Telegram and WhatsApp are written out, so the bot reads what was said.
- Replies read aloud pause at headings, list items and table rows and leave out emoji, addresses and drawn marks; the
  most natural system voice is chosen, and a reply in English is read with an English voice. The reading speed is a
  slider from 0.5x to 2x that a reply being read follows as it moves.

### Apps

- In the desktop app, Cmd/Ctrl+Shift+Space opens a small window listing what the bots wait on, answered from the
  keyboard without switching to the app; it can be turned off from the menu bar.
- Each kind of notice has its own sound, so a question, a permission request and an error can be told apart.
- The folded sidebar keeps the today, board and apps buttons, two to a row, and is wider; a room's faces fit the square
  of a bot's avatar; the sidebar's footer stays tidy at every width.

## 0.3.0 — 2026-11-17

### Safety

- The auto review (the "review" approval level) reads only the person's own words: their latest messages in the
  conversation, the instructions saved on a routine, or, for work another bot handed over, the request it started from.
  A webhook's payload, a routine's last report, another bot's message or a quoted reply no longer counts as what the
  person asked for. To let a step run, the reviewer must quote those words, and the server checks the quote is really
  there; the note in the conversation keeps the quote. Work with no request from the person behind it goes to a card.
- Memory changes a bot asks for while nobody watches (a routine's run, another bot's request) no longer take effect at
  once: they wait under "Waiting for approval" in the memory settings, and the Today page counts them. The person
  accepts or rejects each one, or all at once; a change asked for twice waits once. A bot the person is talking to still
  keeps its memory itself.
- What a connected app or a page in the bot's browser returns reaches the model in an `<outside-data>` block that names
  where it came from and says it is not instructions; a tag in the text that would end the block early is broken up.

### Running it

- Sign a phone or another computer in with a one-time pairing code from a device already signed in (Settings →
  Connection → Connect another device), instead of the password or the access key. A code works once, within five
  minutes; wrong codes are slowed like wrong passwords. The web, the phone and the desktop app's server window take
  it.
- Docker Compose profiles reach the server from elsewhere without opening a port: `--profile cloudflare` runs a
  Cloudflare Tunnel, `--profile tailscale` serves it on your tailnet with HTTPS. The tunnel reaches the server over a
  network of its own with no way out.
- Install on a fresh Ubuntu or Debian server with one command (`docker/install.sh`, from curl or a provider's
  cloud-init box): Docker, the `.env`, AppArmor, the firewall and HTTPS through Caddy (an sslip.io name when there is no
  domain). Running it again, or `yumakbot update`, updates the installation and keeps its secrets and data. The
  firewall rules come back after every reboot and Docker restart, and the server and computer images are published
  for amd64 and arm64 on each version, so a server pulls them instead of building them.

### Connections and models

- Sign in with your ChatGPT plan instead of an OpenAI API key, through OpenAI's "Sign in with ChatGPT", which lets an
  app use a person's plan with its name on the consent page. On the computer that runs the server the sign-in comes
  back by itself; on a server elsewhere you paste the address the browser ended on.
- Sign in with your GitHub Copilot plan with a code typed on GitHub (GitHub Enterprise too); bots get the models your
  plan opens.
- Both are sealed like keys, refreshed when they run out, and signed out from the connection page. A saved API key for
  the same provider comes first.

### Chat

- A microphone button in the message box: speak instead of typing. With an OpenAI or Groq key saved, the recording is
  written out by that provider (on the web and in the desktop app); without one, a browser with its own speech
  recognition (Chrome, Safari) writes as you speak. The desktop app may use the microphone and nothing else of the
  camera or screen; on macOS it asks first. On the phone, the keyboard's own dictation does the same.
- Bots make pictures: with an OpenAI or xAI key saved, `image_create` draws what the bot describes and posts it as a
  file in the chat (Telegram and WhatsApp too). The bot's own provider goes first; only bots with the internet on get
  it, and asking bots open a card first. At most four pictures a turn.
- Bots turn their pages into pictures: `page_to_image` renders a page the bot wrote (a banner, a cover, a social card)
  at the size it asks for and posts the PNG. It costs nothing and runs without a card.
- A file or page a bot hands over while talking to another bot comes to its conversation with the person.
- When a bot's latest reply is in another of its conversations, the chat shows a bar that opens it.

### Bots

- Each bot's settings have a Tools section: give it only the tools listed, or leave some out, named as approval cards
  name them (`Read`, `mcp__gmail__search_threads`), with `*` at the end for a whole app. A small local model gets
  room to work, and a bot stays to its job. Both engines leave the other tools out of the request, and one the engine
  offers anyway is refused.

### Chat apps

- Each bot can have a Telegram bot of its own: paste the token BotFather gives in the bot's settings, then open the
  pairing link (or scan its QR code) and press Start. Only the paired Telegram account is read. What it writes goes to
  the bot's main conversation; while the person last wrote from Telegram, replies, files, "typing…" and approval and
  question cards (with buttons) go back there. `/stop` stops the work in progress and `/new` starts afresh. Routine
  reports and cards from the bot's other conversations can come to Telegram too.
- WhatsApp connects as a linked device, the way WhatsApp Web does, from the new "Chat apps" settings section: with a
  separate bot number only the person's own number is read, and with their own number only "Message yourself". The
  messages go to one chosen bot and `/bot <name>` switches it; cards come with numbered choices that a typed number
  answers. Groups and other people's messages are never read. This uses Baileys, an unofficial WhatsApp client, so a
  separate number is recommended.
- Sign-in cards, secret answers and cards with several questions are left to the Yumak Bot app; passwords never go
  through a chat app.

### Memory

- A password, key or token a bot writes to memory is replaced with a marker before the note is saved, and the bot is
  told to ask for the vault instead: memory reaches the model on every turn, so a secret there would leak with it.
- Writing a note that is already saved, give or take case, spacing and closing punctuation, makes no second copy.
- Each note reaches the bot with the day it was last written, so of two notes that disagree it can trust the newer.
- When memory outgrows the prompt, the notes a bot wrote, changed or looked up most recently go in, rather than the
  newest ones. An old note a bot keeps finding by search stays in the prompt, and one nobody needed makes room. A
  search with a query and a site the bot opens count as looking a note up; being in the prompt does not.
- The memory screen lists the notes no bot uses: nobody changed them and no bot looked them up in 30 days, and no bot reads them on
  every turn. They can be deleted one by one or all at once; a note a bot uses again before that stays. Today shows
  how many there are and opens the memory screen from there.

### Routines

- A routine can wait on an app: before each run it calls a read-only tool of a connected app (unread mail, open
  issues) without the AI, and the bot runs only when the answer changed, with the new answer. A quiet tick costs
  nothing. Bots set it up when asked ("tell me when a new invoice email arrives"); the routine screen shows the check
  and removes it. Only a tool that reads, of an app open to the bot, can be a check.
- A routine pre-check on the usage page, on the web, the desktop and the phone: before a run that a watched page, an app's check or a webhook call started, the
  cheapest Claude model says whether the run has anything new to work on (only page noise changed, an event the
  routine does not care about, nothing beyond the last report). "Watch" only records what it said, beside the run and
  as a total on the usage page with what those runs cost; "On" skips such runs with the reason before the bot starts.
  When it is unsure or fails, the run goes ahead, and reminders always run. It is off by default.
- A watched page keeps its last text, so the pre-check reads the sentences that were removed and added instead of the
  whole page.
- A routine's report lands in the bot's main chat under a label that opens the run's steps, and the bot reads the
  reports that came since its last turn there. Routine conversations leave the list unless a card waits in them or
  they are pinned.
- Bots set the model a routine runs with, and the approval card names it.
- The red mark of a failed routine opens that routine at its latest runs, and goes away once the person has seen the
  failure.

### Browser

- A "Just a moment..." page that clears by itself no longer reaches the bot: opening a site waits for it, reloading
  once, before the bot reads the page. When a site still shows a check a person has to answer, or turns the browser
  away, the bot is told so plainly: hand the step to the person with Take control, or use another source. It is
  never to get past a check itself.
- The bots' browsers can go out through the person's own computer (Settings, one switch for the server): sites that
  refuse sign-ins from a datacenter see the home connection while the desktop app is connected, and the server's
  while that computer is off. The desktop app reaches only web ports on public addresses, so the server never reaches
  the person's own machine or home network. The bots' commands still go out from the server.

### Backups

- A full backup in one file, sealed with a password of your choosing (scrypt and AES-256-GCM): the bots,
  conversations, memory, routines, skills, connections, the bots' folders, and the vault key the saved logins need.
  Download it under Settings → Import and backup, on the web, the desktop or the phone.
- Restoring one, on the web or the desktop, replaces everything on the server with what the file holds, then starts the
  server again. A wrong password, a damaged file or a backup from a newer version changes nothing, and a restore waits
  until no bot is working. The folders it replaced stay beside the new ones as `*.before-restore` until the next
  restore. Who is signed in to the server stays signed in.

### Apps

- The desktop app for Linux: an AppImage that updates itself, and a `.deb` for Debian and Ubuntu, built by the release
  workflow with the others.
- `yumakbot://` links open a bot, a conversation or a room in the desktop app from outside it (a bookmark, a dashboard,
  a script). In the desktop app, "Copy a link to this conversation" copies one, and such a link pasted into a chat
  opens the conversation in place.
- The desktop app itself is called "Yumak Bot": the macOS menu bar and Dock, the Windows exe and shortcuts. macOS takes
  the menu bar title from the app bundle, so the menu's own label did not reach it. The installer and update files
  keep "YumakBot" in their names, and so do the data folder and the keychain entry. An app that updates itself keeps
  its folder name; renaming `YumakBot.app` to `Yumak Bot.app` in Applications fixes the name the Dock shows.
- On the phone, the bots' avatars look around and blink like on the web and the desktop.

## 0.2.1 — 2026-11-16

### Apps

- The desktop app updates itself from GitHub releases on macOS and Windows: a new version downloads in the background,
  and the app offers to restart into it or installs it when it quits. Apps from 0.2.0 and earlier have no updater, so
  this version is installed by hand once.

### Memory

- A manager bot also sees, corrects and deletes the own notes of bots that are not managers, archived ones included;
  `memory_search` names the bot each note belongs to and takes a bot to list one bot's notes alone. It is told that
  the other bots still see only their own notes, so a fact is not deleted from a bot just because it exists elsewhere.
- The memory screen shows one line per bot with its number of notes; a bot's notes open below it when tapped.

## 0.2.0 — 2026-11-16

### Apps

- A phone app for iOS and Android, built with Expo, with every screen of the web app's phone layout: bots, rooms,
  conversations, Today, search, the editors and every settings section. It is run from source for now; see the README.
- The product name is written "Yumak Bot", with a space, everywhere a person reads it. Code names, package names,
  environment variables and the desktop app's install path keep "YumakBot", so an existing installation stays as it is.
- Larger text, icons and avatars on the web and the phone.
- A sent message stays in place until the server's copy arrives instead of seeming to land twice.
- The bot's browser opens as a small card with the actions that fit while there is no picture to show.
- The icons in the macOS installer window are centered.

### Connections and models

- One card on the connection page holds every AI the bots can use (Claude, each provider with a key, each endpoint)
  with a single "add a provider"; the model card only chooses. The phone has the same layout.
- A model a provider does not list yet can be named by hand, for a built-in provider and for an endpoint; its price is
  unknown and counted as nothing.
- Model names can be searched as you type, and Claude settings fold away when another provider is chosen.
- Trying an OpenCode model works; the test request now names a session, as OpenCode requires.

### Memory

- Bots' notes take effect as soon as they are written, without waiting for approval, so a bot can use and tidy notes
  written by routines, other bots or an import.
- Bots can correct a note with `memory_update` and delete one with `memory_forget`, for their own notes and the shared
  memory but not another bot's notes; `memory_search` without a query lists every note the bot sees.
- Importing bots copies only what the other app saved as memory, and imported notes are saved active.
- The memory screen groups the bots' notes by bot, archived bots marked, and one bot's notes can be deleted at once.

### Running it

- `docker/apparmor.sh` checks a Linux host and picks the `YUMAKBOT_APPARMOR` value the shell and desktop sandboxes need,
  loading the AppArmor profile only where it is required.

### Upgrading from 0.1.0

- Notes that were waiting as proposals become active memory the bot can see, and the memory status goes away; no note
  is lost. The API still reports status `active` on every note for phone builds made before this change.

## 0.1.0 — 2026-11-15

The first public release.

### Bots

- Create as many bots as you like and group them; each has its own name, avatar, instructions, model, memory, files
  and permissions.
- Two engines: Claude through the Claude Agent SDK (a Claude subscription token or an Anthropic API key), or models
  from other providers with your own key.
- A manager bot can create, update and hand work to other bots; bot-to-bot messages are guarded against loops.
- Rooms: a group conversation where chosen bots talk with you and with each other.
- Skills, imported from a link, with a warning for skill text that hides something.
- Import bots exported from other assistants, and export your own to a file the importer reads.

### Chat

- Streamed replies, file attachments, stopping at any time, and turns that carry on after a server restart.
- Unread marks, find in a conversation, `/` commands, quick replies, a goal per conversation, branching from a reply,
  Markdown export, sortable tables and Mermaid diagrams.
- Approvals: bots ask before using a tool you have not allowed, and a decision can be remembered per bot.

### Memory, routines and usage

- Bots keep notes across chats (or work without memory) and look through their past conversations.
- Routines run on a schedule (including cron and day and hour windows), when the server starts, from a filtered
  webhook, or when a watched page changes. Bots can turn their routines off, change them and delete them.
- A Today page of what the bots did and what waits for you.
- Spending by bot, model and routine, a monthly limit and a CSV export.
- Call a bot from a script with the access key and get its reply.

### Tools

- Connections to remote MCP servers, chosen per bot, with more than one account per service.
- A browser per bot, which you can watch live and take over for sign-ins and verification codes.
- A password vault: you type credentials into a card and the server fills them in; the bot never sees them.
- An optional sandboxed Linux desktop per bot (Docker), viewable from the app.
- Claude's shell commands run in a sandbox that sees only the bot's own folders; one switch per bot turns its internet
  access on or off.

### Apps

- A desktop app for macOS that runs its own server or connects to a remote one.
- A web app served by the server, in English and Turkish.

### Running it

- On your own computer through the desktop app, or on a Linux host with Docker Compose.
- PostgreSQL, or embedded PGlite when no database URL is set.

### Upgrading from an earlier build

- Turns used to store the running cost of their whole Claude session instead of their own, which inflated the usage
  report and the monthly limit. On start the server recalculates the stored cost of earlier Claude turns once; the new
  figures are estimates, since earlier turns did not record where a session began.

### Known limitations

- The desktop installer is built from source; see the README.
- There is no phone app yet; the web app works in a phone's browser.
- Spending figures are estimates reported by the engines, not a bill.
