export interface Conflict {
  start: number;
  end: number;
  line: number;
  endLine: number;
  yours: string;
  theirs: string;
  base?: string;
}

export function parseConflicts(text: string): Conflict[] {
    const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((match) => match[0].length > 0);
    const result: Conflict[] = [];
    for (let i = 0; i < lines.length; i++) {
        const marker = /^(<{7,})(?: .*?)?\r?\n?$/.exec(lines[i][0]);
        if (!marker)
            continue;
        const width = marker[1].length;
        const is = (line: string, char: string) => new RegExp(`^${char}{${width}}(?: .*?)?\\r?\\n?$`).test(line);
        let divider = -1, ancestor = -1, end = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (is(lines[j][0], "<"))
                break;
            if (is(lines[j][0], "\\|") && divider < 0)
                ancestor = j;
            if (is(lines[j][0], "=") && divider < 0)
                divider = j;
            if (is(lines[j][0], ">") && divider >= 0) {
                end = j;
                break;
            }
        }
        if (divider < 0 || end < 0)
            continue;
        const at = (n: number) => lines[n].index!;
        result.push({
            start: at(i),
            end: at(end) + lines[end][0].length,
            line: i + 1,
            endLine: end + 1,
            yours: text.slice(at(i) + lines[i][0].length, at(ancestor >= 0 ? ancestor : divider)),
            theirs: text.slice(at(divider) + lines[divider][0].length, at(end)),
            ...(ancestor >= 0
                ? {
                    base: text.slice(at(ancestor) + lines[ancestor][0].length, at(divider)),
                }
                : {}),
        });
        i = end;
    }
    return result;
}
export function hasConflictMarkers(text: string): boolean {
    return /^(?:<{7,}(?: .*)?|={7,}|>{7,}(?: .*)?|\|{7,}(?: .*)?)\r?$/m.test(text);
}
