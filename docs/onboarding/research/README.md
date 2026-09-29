# Asking your agent to research your device

Your agent can look things up for you — the manual, the safety limits, the
calibration procedure, whether someone already built a driver for your
machine. This page is a short guide to asking it well. No jargon required.

## How to ask a good research question

1. **Name the exact model.** "My 3D printer" finds nothing useful. "Prusa
   MK4S" finds the manual. If you're not sure of the exact model, say what's
   on the label — even a blurry photo of the nameplate is enough for your
   agent to work from.
2. **Ask for the manual section, not just an answer.** "What's the max bed
   temperature?" can get you a guess. "Find the section of the manual that
   lists the max bed temperature, and quote it" gets you a fact you can trust.
3. **Ask for citations.** Every research answer your agent gives you should
   come with a source: a document name, a section, and ideally a link. If it
   doesn't have one, ask it to keep looking — or say so yourself, so the
   answer isn't recorded as confirmed.
4. **Ask for limits to be quoted word for word.** For anything safety- or
   money-related, a paraphrase isn't good enough. Ask your agent to copy the
   exact sentence from the manual, not summarize it.

A few sentences you can reuse directly:

- "Find the programming manual for **\<model\>** and list how it is
  remote-controlled."
- "Find the parameter ranges for **\<capability\>** in the **\<model\>**
  manual, and quote the numbers."
- "Find the safety limits and e-stop requirements for the **\<model\>** in
  its manual, quoted word for word."
- "Find the calibration procedure and interval for the **\<model\>**."
- "Check whether a kit already exists for this device before we build one."

## Never accept an unsourced number for a safety limit or a price

This is the one rule that matters most. If your agent (or anyone else)
gives you a number for a safety limit — a maximum temperature, a maximum
pressure, an allowed material — or a price, and it doesn't come with a
citation you can check, don't accept it. Ask where it came from. If the
answer is "I inferred it" or "that's typical for this kind of device," that
is not good enough. Safety limits and prices are never defaulted, never
guessed, and never assumed — they are either sourced from the manufacturer's
own documentation or set by you, the person who actually knows.

This also means: if you don't know a safety limit yourself, and your agent
can't find a sourced one either, the honest answer is "I don't know yet" —
not a guess in either direction.

## What to do when nothing is found

Sometimes there's no manual online, the model is too old or too obscure, or
the vendor never published the information. That's normal. Here's what to do,
in order:

1. **Take a label photo.** Most devices have a nameplate with the exact
   model number, sometimes a manufacture date, and sometimes even contact
   information for the manufacturer. A clear photo of this label is often
   enough for your agent to identify the device precisely, even when a text
   description isn't.
2. **Contact the vendor directly.** Manufacturers can usually supply a
   datasheet, a safety sheet, or a calibration procedure even when it isn't
   published online. Use the template email below.
3. **If nothing comes back, do a physical check with instructions.** Some
   facts can be measured directly instead of researched — for example,
   running the device at low power and observing the result, or checking a
   physical dial or switch. When this is the only option, your agent should
   give you clear, safe, step-by-step instructions rather than asking you to
   guess.

### Template email to a vendor

> Subject: Documentation request — \<model\> (safety limits / calibration
> procedure / I/O specification)
>
> Hello,
>
> I own a \<vendor\> \<model\> (serial number \<serial number, if you have
> it\>) and I'm setting it up on the Physical Capability Cloud, an
> agent-native network for physical equipment. I'm looking for whichever of
> the following documents you're able to share:
>
> - the safety limits and hazard/PPE guidance for this device,
> - the recommended calibration procedure and interval,
> - the I/O or parameter specification (ranges, units, tolerances),
> - the remote-control or telemetry interface (protocol, API, or SDK
>   documentation), if one exists.
>
> A PDF or a link to your existing documentation is perfect — I don't need
> anything written specially for me.
>
> Thank you,
> \<your name\>

## Why this matters

Every research finding your agent records keeps a citation and a retrieval
date, and safety, I/O, and money findings always require your confirmation
before they become part of your device's record (see
`packages/spec/src/onboarding/research/library.ts` for the entries this
guide corresponds to, and `packages/spec/src/onboarding/intake/fields.ts` for
where each finding ends up). This isn't bureaucracy for its own sake — it's
the difference between a safety limit you can trust and one somebody made up.
