/**
 * Hands-free voice command parsing. Anything that is not a recognised command
 * is treated as a question for the assistant.
 */
export type VoiceCommand =
  | { type: "next" }
  | { type: "prev" }
  | { type: "repeat" }
  | { type: "goto"; step: number }
  | { type: "first" }
  | { type: "last" }
  | { type: "parts" }
  | { type: "tools" }
  | { type: "stop" }
  | { type: "explode"; enabled: boolean }
  | { type: "ask"; text: string };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/** True when every word is a number word or digits (optionally joined by "and"), e.g. "twenty one". */
export function isNumberPhrase(text: string): boolean {
  const words = text.trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => /^\d+$/.test(w) || w in NUMBER_WORDS || w === "and" || w === "number");
}

export function parseNumber(text: string): number | null {
  const digits = text.match(/\d+/);
  if (digits) return parseInt(digits[0], 10);
  const words = text.toLowerCase().split(/[\s-]+/);
  let total = 0;
  let found = false;
  for (const w of words) {
    if (w in NUMBER_WORDS) {
      const n = NUMBER_WORDS[w];
      if (n >= 20 && total === 0) total = n;
      else total += n;
      found = true;
    }
  }
  return found ? total : null;
}

export function parseVoiceCommand(transcript: string): VoiceCommand {
  const t = transcript.trim().toLowerCase().replace(/[.,!?;:]+/g, "").replace(/\s+/g, " ").trim();
  const words = t.split(/\s+/).filter(Boolean);
  const short = words.length <= 4;
  const shortish = words.length <= 7;

  if (!t) return { type: "ask", text: transcript };

  if (/^(stop|be quiet|quiet|shut up|pause|silence|mute)( talking| speaking)?$/.test(t)) return { type: "stop" };

  if (short && /^(ok |okay |alright |please )?(next|continue|done|go on|next step|i'?m done|finished|move on|next one|proceed)( step| please)?$/.test(t)) {
    return { type: "next" };
  }
  if (shortish && /^(ok |okay |please )?(go to |jump to |skip to |move to |take me to )(the )?next( one| step)?( please)?$/.test(t)) {
    return { type: "next" };
  }
  if (short && /^(ok |okay |please )?(back|go back|previous|previous step|undo|step back)( please)?$/.test(t)) {
    return { type: "prev" };
  }
  if (shortish && /^(ok |okay |please )?((go to |jump to |take me to )(the )?(previous|last)( one| step)|go back (one|a step|one step))( please)?$/.test(t)) {
    return { type: "prev" };
  }
  if (short && /^(ok |okay |please )?(repeat|again|say that again|say again|repeat that|one more time|pardon|what)( please| step)?$/.test(t)) {
    return { type: "repeat" };
  }
  if (/^(go to |jump to |show |open |take me to |skip to |back to )?(the )?(first step|start|beginning|step one)$/.test(t)) return { type: "first" };
  if (/^(go to |jump to |show |open |take me to |skip to )?(the )?(last step|final step|end)$/.test(t)) return { type: "last" };

  // "go to step 7", "show step three", "jump to step twenty one": a verb, then "step", then only a number.
  const gotoStep = t.match(/^(?:ok |okay |please )?(?:go to|jump to|show|show me|open|take me to|skip to|move to)\s+(?:the\s+)?step\s+(.+?)(?:\s+please)?$/);
  if (gotoStep && isNumberPhrase(gotoStep[1])) {
    const n = parseNumber(gotoStep[1]);
    if (n != null && n > 0) return { type: "goto", step: n };
  }
  // "go to 7", "skip to five": a movement verb followed by nothing but a number.
  const gotoBare = t.match(/^(?:ok |okay |please )?(?:go to|jump to|take me to|skip to|move to)\s+(?:the\s+)?(.+?)(?:\s+please)?$/);
  if (gotoBare && isNumberPhrase(gotoBare[1])) {
    const n = parseNumber(gotoBare[1]);
    if (n != null && n > 0) return { type: "goto", step: n };
  }
  // "step twelve"
  const stepN = t.match(/^step\s+(.+)$/);
  if (stepN && isNumberPhrase(stepN[1])) {
    const n = parseNumber(stepN[1]);
    if (n != null && n > 0) return { type: "goto", step: n };
  }

  if (shortish && /^(which |what )?(parts|hardware|what parts|which parts|what do i need|parts list|list (the )?parts)( do i need| for this step| now)?$/.test(t)) {
    return { type: "parts" };
  }
  if (shortish && /^(which |what )?(tools|what tools|which tools|tools needed)( do i need| for this step)?$/.test(t)) return { type: "tools" };

  if (/^(explode|exploded view|show exploded view|blow it up|spread (the )?parts( out)?)$/.test(t)) return { type: "explode", enabled: true };
  if (/^(collapse|assembled view|put it back( together)?|normal view|unexplode)$/.test(t)) return { type: "explode", enabled: false };

  return { type: "ask", text: transcript.trim() };
}
