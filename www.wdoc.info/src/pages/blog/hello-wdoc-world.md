---
title: 'Hello wdoc world'
description: 'Introduction of the wdoc format.'
date: '2025-12-02'
layout: ../../layouts/BlogPostLayout.astro
image: '/assets/hello-wdoc-world.png'
---

Every day in my job, I open PDFs that should have been simple to work with… but aren’t.  
Parsing them is painful, extracting structure is unreliable, and trying to reuse or automate anything inside them is an exercise in frustration. Documents lose their semantics, forms become static, and templates are nearly impossible to reuse or standardize.

At some point, I thought: _why are we still doing this to ourselves?_  
That question eventually became **wdoc**.

## Why wdoc?

PDF was designed for print, not for structure. It’s fantastic for preserving layout but terrible for everything else.  
As someone who regularly needed to extract data, validate content, generate variations, or process forms, I kept hitting the same walls:

- No consistent structure
- Complex and fragile parsing
- Non-semantic content
- Nightmarish automation

I wanted something that preserved meaning, not just pixels. Something a dev could grasp in a matter of minutes

## What is the wdoc format?

At the most basic, wdoc is just a zipped index.html (I stole the zip idea for docx format), you can't make it simpler.

I wanted something that was dead simple and understandable by the vast majority of dev people. That's why html is the way to go for all these reasons:

- explicit structure
- predictable styling
- abundant tooling
- easy rendering
- natural extensibility

If you know how to build a webpage, you can build a document.

And you can inspect, modify, or generate it programmatically **without pain**.

## A side quest - vibe coding

My day-to-day project is far too big and far too old (started in 2009, in PHP!) to fit neatly into the current “vibe coding” era.  
So wdoc became my playground: a clean slate to test how far this new coding paradigm can go.

I’ll document the journey here: what works, what doesn’t, what surprises me, and where I inevitably get frustrated when my prompting skills aren’t enough to match the ideas in my head.

Maybe we’ll shake up the PDF world.  
Maybe we’ll end up in the graveyard of projects that didn’t get enough traction.

Either way, it should be a fun ride.
