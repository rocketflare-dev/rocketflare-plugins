# The user guide: voice and style

This is how the guide sounds. Read it before you write or edit a page. It is not a page itself:
the build skips this file.

## Who we're writing for

The reader is **someone using this app at work**: a member doing their job, or an admin running
their organisation. They are busy, they did not choose the tool, and they opened the guide because
something on screen did not make sense. They want the answer and the next click.

A page gives them four things, in this order:

1. **What it is.** In a sentence or two, before anything else.
2. **Why it works this way**, when the reason helps them act. One or two sentences.
3. **How to do it.** The exact screen, the exact button, in order.
4. **What goes wrong.** The message they will see, what it means and what to do next.

If a page can't do all four, it is probably two pages.

## The voice in a sentence

We sound like a colleague who knows the app well, showing someone at the next desk: direct, plain,
sure of what we know, and honest about what the app does not do.

- **Direct.** Lead with the point. Put the reason second.
  Do: "Invitations expire after {{fact:invitation.expiry_days}} days." Don't: "Please be aware
  that invitations may be subject to an expiry period."
- **Plain.** Use the words on the screen and the words the reader would use. Name a thing once,
  clearly, and keep calling it that.
- **Confident, not breathless.** State what the app does. Don't sell it: no "powerful",
  "seamless", "effortless", "unlock".
- **Practical.** Every idea comes with a moment the reader will recognise: the button they click,
  the message they see.
- **Honest about the edges.** If something can't be done, say so in the same breath. Never
  describe a feature that is planned as if it were built.

## Sentences and paragraphs

- **Person.** Speak to the reader as "you". Say which person acts when it is not the reader: "an
  admin", "the person you invited". Avoid "the user".
- **Rhythm.** Most sentences run 12 to 20 words. After two or three, use a short one to land the
  point.
- **Active voice.** "An admin sends the invitation", not "the invitation is sent".
- **Defining terms.** Bold a term the first time it appears and define it in the same sentence.
- **Lists** for parallel things: steps, options, failure modes. Bold the first few words of each
  item. Prose where there is an argument to follow.
- **Paragraphs** of two to four sentences, claim first.

Avoid: throat-clearing ("It's important to note"), hype, rhetorical questions, emoji, exclamation
marks, and internals a reader never touches (table names, job names, file paths).

## Page shape

1. **An opening paragraph, with no heading.** What this is and why it exists, in three sentences or
   fewer.
2. `## How it works`: the flow in order, and who acts at each step.
3. `## Do it`: the exact clicks, as numbered steps.
4. `## Watch out for`: the sharp edges and the messages, and what to do about each.

Headings are in sentence case and short. Never go deeper than `###`: the build refuses `####`.

## Callouts

A callout is a blockquote: a bold uppercase label from `calloutLabels` in `guide.config.json`, an
em dash, then the text. Two at most per page.

```markdown
> **RULE OF THUMB** — Invite people with the role they need today. You can raise it later.
```

## Vocabulary

**The screen is the source of truth.** If the button says **Invite**, the guide says **Invite**,
in bold, with the same capitals. If the screen changes, the guide changes in the same commit.
Keep a table here of the words this app uses and the words it doesn't:

| say | not |
|---|---|
| organisation | tenant, workspace (unless the screen says so) |
| member, admin, owner | user, superuser |
| sign in | log in, login |

## Facts

**Never type a number, limit or duration the code owns.** Write `{{fact:key}}` and add the key and
its value to `facts` in `guide.config.json`. The build fails a page that uses an unknown key, and
`/guide sync` re-checks the values against the code.

## Links

Link the way markdown files do, relative to the page: `[Signing in](../start/signing-in.md)`,
`[invitations](inviting-people.md#watch-out-for)`. A `#hash` is the heading lowercased, punctuation
dropped, spaces turned into hyphens. The build fails a link to a page or heading that doesn't
exist, and a member page may not link to an admin page.

## HTML

Markdown first. Raw HTML only where markdown can't do the job: `<kbd>` for keys, `<details>` to
fold a long reference block, a table that needs `colspan`. The reader sanitises it: no script, no
styles, no frames. Headings and links stay markdown.

## Images

Put an image in `docs/guide/images/` and reference it as `![alt](images/name.png)` (relative to the
page). Alt text says what the picture shows. An SVG needs a `<title>` and no script, event handler,
stylesheet or outside reference. Images are public static files: never show private data in one.
