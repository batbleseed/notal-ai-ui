# Skills

Notal AI Studio reads this file on every request and adds what is in it to the
model's instructions. Edit it, save it, and the next message already uses it —
there is no restart and no build step.

Studio keeps a copy here: `%APPDATA%\Notal AI Studio\skills.md`. The tray menu
item "Open skills.md" takes you straight to it. Anything you write below this
line is what the AI is told about you.

## How to write a good skill
- One instruction per line, in your own words. Short beats clever.
- Say what you want, not what to avoid, unless the thing to avoid is specific.
- Include the details the model cannot guess: the stack you use, the names of
  your folders, the style your writing has, the things you already know.

## Work
- You are building:
- Your experience: (for example "beginner, I learn by reading the file, not the docs")
- Explain things by: (for example "show the file and the line, then why")

## House rules for answers
- Keep replies tight. Lead with the answer, then the reason.
- Never invent a link, a package name or an API. If it is unsure, say so.
- When it writes code for a UI, one complete file, language named, ready to run.
- Ask before anything that spends money, deletes work, or touches a live site.

## Projects
- Notal AI: the app you are talking inside. Static web app plus this desktop
  build; state lives in this machine's storage; providers are configured in
  Settings.
