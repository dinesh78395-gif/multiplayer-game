# multiplayer-game
A fast-paced neon multiplayer word game where players race the clock, fill five categories, and battle for the top score—with confetti explosions for the winner.
📁 Project Layout Explained (alphabet-spin)
alphabet-spin/
  server.js
  package.json
  package-lock.json
  public/
    index.html
  README.md
  .gitignore


Breakdown of each part:

📘 server.js

This is the backend of the game.

It handles:

Creating and managing multiplayer rooms

Assigning letters for each round

Tracking turns

Validating answers

Maintaining player scores

Detecting winner/draw

Sending events to all connected clients using Socket.IO

Hosting the frontend files (index.html)

Basically:
👉 The entire game logic & multiplayer system lives here.

📦 package.json

This file stores:

The project name & version

All dependencies like express and socket.io

The "start": "node server.js" script

Metadata about the project

It ensures anyone who downloads your repo can install everything with:

npm install

📚 package-lock.json

Automatically generated file.

It:

Locks the exact versions of all installed packages

Ensures the game installs identical versions for everyone

Makes deployments consistent and bug-free

You don’t need to manually edit it.

🎨 public/ (folder)

Contains all frontend files the browser loads.

Inside:
public/
  index.html

index.html:

The full UI (Neon theme)

The game screen

Socket.IO client code

The timer, input boxes, toast notifications

Confetti animations

The “type legit 😅” modal

Everything the players see

Every button, animation & visual element comes from this file.
