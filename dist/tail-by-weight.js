/**
 * Where turns start: at a user's message. A tool's answer is a message of the
 * role `toolResult`, never a start -- a call is not torn from its answer.
 */
export function turnStarts(messages) {
    const starts = [];
    messages.forEach((message, index) => {
        if (message.role === "user") {
            starts.push(index);
        }
    });
    return starts;
}
/**
 * The longest tail, by whole turns and not shorter than the floor, whose weight is
 * not above the cap. The weight grows with the length, so the search is binary:
 * about log2 of the starts in questions to the handle. A weight the handle did not
 * give is no weight at all (PLAN-gorizont 5а, 11.10): `weigh` fails and so does the
 * search -- nothing is decided for the counter. When even the shortest eligible tail
 * is too heavy, it is the one: the floor is stronger than the weight. No eligible
 * tail -- null.
 */
export async function longestTailWithin(params) {
    const { total, floor, cap, weigh } = params;
    const eligible = params.starts.filter((start) => start >= 0 && start < total && total - start >= floor);
    if (eligible.length === 0) {
        return null;
    }
    const weights = new Map();
    let asked = 0;
    const weightOf = async (start) => {
        const known = weights.get(start);
        if (known !== undefined) {
            return known;
        }
        asked += 1;
        const weight = await weigh(start);
        weights.set(start, weight);
        return weight;
    };
    const fits = async (start) => (await weightOf(start)) <= cap;
    // eligible[0] is the longest tail; the first that fits is the answer, and
    // the shortest eligible is the answer when none fits.
    let lo = 0;
    let hi = eligible.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await fits(eligible[mid])) {
            hi = mid;
        }
        else {
            lo = mid + 1;
        }
    }
    const start = eligible[lo];
    return { start, weight: await weightOf(start), asked };
}
/** The shortest tail by whole turns that is not shorter than the floor: the floor alone, no weight. */
export function floorTail(starts, total, floor) {
    const eligible = starts.filter((start) => start >= 0 && start < total && total - start >= floor);
    return eligible.length > 0 ? eligible[eligible.length - 1] : null;
}
