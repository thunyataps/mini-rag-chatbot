"use client";

/**
 * There's no login system in this project. Instead, each browser gets a
 * random id stored in localStorage the first time it's used. Documents are
 * tagged with this id so a user only sees the documents they uploaded from
 * this browser - a lightweight stand-in for "session/document separation".
 */
const SESSION_KEY = "mini-rag-session-id";

export function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}
