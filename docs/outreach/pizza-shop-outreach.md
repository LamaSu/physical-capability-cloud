# Reaching a pizza place — tactical-empathy script

For walking into a shop, DMing the owner, or handing a flyer to whoever runs
the counter. Tactical empathy borrowed from Chris Voss / *Never Split the
Difference*. The frame is **make it easy for them to say no, surface their
objections before they have to**, let them feel heard.

The goal of the first contact is **not** to sign them up. It's to earn the
five-minute conversation where they tell you what's actually broken about
their day. The system gets built around what they say.

---

## The opener (in person or DM, ≤80 words)

> Hey — I'm not selling anything and I'm not from Uber Eats or DoorDash. You're
> probably going to think this is another tech pitch and want to nod me out
> the door. Totally fair.
>
> I'm building a way for people to order pizza directly from you using their
> AI assistant — no app, no marketplace, no 30%. You'd keep the customer.
> I'm looking for one or two shops to test it with me for free for a few
> weeks. Mind if I leave you a one-pager and come back Tuesday?

Why each line is doing work:

| Line | Tactic | What it does |
|------|--------|--------------|
| "I'm not selling anything and I'm not from Uber Eats / DoorDash" | **Accusation audit** | Names the two things they're already bracing for. They relax. |
| "probably going to think this is another tech pitch and want to nod me out" | **Accusation audit** | Names the brush-off so they don't have to reach for it. |
| "Totally fair." | **Concession** | Lowers their guard. You're not going to argue. |
| "no app, no marketplace, no 30%" | **Specific contrast** | Three concrete pains in seven words. Not hypothetical. |
| "looking for one or two shops" | **Scarcity + loss aversion** | They're not the mark, they're the candidate. |
| "for free for a few weeks" | **Removes the gate** | No PO, no commitment, no IT lift. |
| "mind if I leave you a one-pager and come back Tuesday" | **Calibrated question** | Easy yes. The yes that opens the next door. |

**Hard rule: do NOT mention "blockchain", "Web3", "smart contract", "crypto",
"escrow", "attestation", or "verifiable" anywhere in the opener.** Those words
are a brush-off trigger for a pizza shop owner, and none of them describe the
benefit. The benefit is *keep the customer, keep the margin, no new tablet*.
The cryptography is invisible plumbing — they don't care, and shouldn't.

---

## If they engage — three calibrated questions

Not a pitch. Three open-ended questions that let them describe their world.
Their answers shape the integration.

1. **"How are you taking orders right now — phone, walk-in, DoorDash, all of
   the above?"**
   Tactic: open-ended discovery. You're listening, not selling. Whatever they
   answer is the input to the channel record their onboarding agent will
   write. *Don't suggest answers.*

2. **"What's the part of a busy Friday night you'd pay to make go away?"**
   Tactic: loss aversion + their words. Whatever they say next — "tickets
   getting lost", "the driver doesn't know where they're going", "the third-
   party drivers are rude to customers" — becomes the demo. You build the
   first integration around exactly that pain.

3. **"If a customer's AI assistant could send a ticket straight to your
   printer the way DoorDash sends one to your tablet, but it was *your*
   customer and no fee — what would have to be true for you to try it for
   one week?"**
   Tactic: calibrated question + reverses the burden. They name their own
   conditions. Whatever they say ("I'd need to be able to reject orders if
   we're slammed", "the customer would need to pay up front", "you'd need
   to call me when the first one comes in") is the spec.

**Listening rule:** after each question, count to four before you speak. Most
shop owners haven't been asked these questions; the second sentence is the
real one. Don't step on it.

---

## The "that's right" moment

You're aiming for the moment they say some version of "yeah, that's exactly
the problem" or "right, that's what kills us." That sentence is the signal
they feel heard. **Do not pitch in the next 60 seconds.** Let it land. Then:

> Want me to set it up so the next time someone in [neighborhood] asks their
> ChatGPT or Claude for a pizza, the ticket comes straight to your [whatever
> they just told you they already use — printer, tablet, phone, the kid at
> the counter] with no app and no fee, and we just see how it feels for a
> couple weeks?

Notice: their words. Their setup. Their timeline. Your job is the wiring.

---

## Common objections — pre-loaded responses

The substrate handles each of these by design; here's how to say it in their
language.

**"We're already on DoorDash and that's enough."**
> Totally fair. This isn't a replacement — it's a side door for the customers
> who already prefer to ask their AI assistant instead of opening an app. If
> nobody uses it for two weeks, you turn it off and you've lost nothing.

**"I don't have time to learn another system."**
> That's why I'm asking what you already use. Whatever it is — phone, the
> printer, a Square tablet, sticky notes — that's where the order goes. There's
> no new system to learn. The setup conversation takes maybe twenty minutes
> with me.

**"What's the catch?"**
> Honest answer: I'm building a network and you'd be one of the first shops on
> it. If it works for you and you start getting orders, I want the right to
> say "this network handles real orders at real shops" when I'm talking to the
> next shop. That's it. No subscription, no fee for the first ninety days.

**"How do I know the customer is real and not some bot scamming us?"**
> Customer's AI assistant has to put the money up front before the ticket ever
> reaches you. If the pizza doesn't get made — say you're closed, or you're
> too slammed — the money goes back. You never make a pizza you don't get paid
> for. *That's the part the system does in the background; you don't see any
> of it.*

**"We don't have a website, we're not tech people."**
> Perfect. You're the operator I want first. If it works for you it'll work
> for anyone. The whole onboarding is me asking you how you take orders today
> and writing it down. No website needed.

---

## The one-pager (leave-behind)

If they wave you off but accept the paper, this is what's on it. One side.
Big letters. No QR code to a 90-page whitepaper.

```
[YOUR SHOP NAME] — pizza, direct from your customer's AI

What it is
A way for someone to ask their AI assistant (Claude, ChatGPT, Gemini, Siri)
for a pizza and have the ticket come straight to you — your way.

What it isn't
- Not a delivery app. We don't take a cut.
- Not a marketplace. They asked for YOUR pizza.
- Not a new tablet. We send orders however you already get orders.

What we ask
- 20 minutes to tell us how you take orders today.
- 2 weeks to see if any come in.
- An honest "this isn't working" if it isn't.

What it costs
- Nothing for the first 90 days.
- After that, nothing per order. We have a different way of making
  money that doesn't come out of your pocket.

[YOUR NAME] · [YOUR PHONE] · [YOUR EMAIL]
Come by Tuesday afternoon, or call.
```

---

## What the "different way of making money" is (for your reference, not the flyer)

The substrate earns from the **agent side** — discovery, routing, evidence,
the compose engine — not from the shop side. Shops are the *supply* and
supply is what makes the network valuable. Charging supply for being supply
is the DoorDash mistake. Don't repeat it in the pitch and don't repeat it
in the business model.

If they ask "no really, how do you make money," say:

> The customer's AI agent pays a small fee to use the network — like an API
> call. Shops are free forever because shops are the reason the network is
> worth anything.

That's true. Say it that way.

---

## What you say if a shop says yes

Stop selling. Switch to onboarding.

1. "Can I sit at your counter for twenty minutes while we set this up?"
2. Open the operator-onboarding URL on your phone (or laptop if they let you).
3. Start the onboarding agent. Let it ask the shop owner the channel
   questions in plain English — "how do you want PCC to ping you when an
   order comes in?" — and write the channel record from their answers.
4. Run the test dispatch (`POST /api/operators/:slug/channels/test`). If the
   printer prints, if the phone buzzes, if the tablet pings — whatever they
   said — celebrate that one second. It's the demo.
5. Tell them what to do if it goes wrong, write your phone number on the
   receipt that just printed, leave.

That's it. The integration is conversation, not configuration.

---

## What you do NOT do

- Do not use the words "blockchain", "Web3", "crypto", "token", "smart
  contract", "escrow", "attestation", "evidence bundle", "ALCOA", "verifier",
  or "decentralized." Not in the pitch, not in the flyer, not in the
  onboarding. Those words live one layer below the operator's awareness on
  purpose.
- Do not promise volume. You don't know if anyone will order on day one.
  Say: "I don't know if you'll get one order or thirty. Either way you find
  out for free."
- Do not let the conversation drift to "the platform." This is about *their*
  shop, *their* customers, *their* Friday night. The substrate stays invisible.
- Do not hand them an iPad and say "fill out this form." A conversation. A
  call. A scrap of paper. They live in the physical world; meet them there.
