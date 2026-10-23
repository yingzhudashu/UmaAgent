import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeInstrumentation, parseInstrumentation } from "./android-instrumentation.mjs";

const result = (name, code = 0, count = 1) =>
  `INSTRUMENTATION_STATUS: class=sample.Test\nINSTRUMENTATION_STATUS: test=${name}\nINSTRUMENTATION_STATUS: numtests=${count}\nINSTRUMENTATION_STATUS_CODE: ${code}\n`;
const complete = (body, count = 1) => `${body}OK (${count} tests)\nINSTRUMENTATION_CODE: -1\n`;
test("requires every discovered test and a successful terminal record", () => {
  assert.equal(parseInstrumentation(complete(result("one")), ["sample.Test#one"]).passed, true);
  assert.equal(
    parseInstrumentation(complete(result("one")), ["sample.Test#one", "sample.Test#two"]).passed,
    false,
  );
  assert.equal(parseInstrumentation(result("one"), ["sample.Test#one"]).passed, false);
  assert.equal(parseInstrumentation(complete(result("one", 0, 2))).passed, false);
  assert.equal(parseInstrumentation(complete(result("one") + result("one"), 2)).passed, false);
});
test("accepts only explicitly documented conditional skips", () => {
  const skipped = complete(result("tablet", -4));
  assert.equal(parseInstrumentation(skipped).passed, false);
  assert.equal(parseInstrumentation(skipped, ["sample.Test#tablet"], ["sample.Test#tablet"]).passed, true);
  assert.equal(parseInstrumentation(complete(result("one", -2))).passed, false);
  assert.equal(parseInstrumentation(`${complete(result("one"))}INSTRUMENTATION_FAILED\n`).passed, false);
});

test("isolated classes cannot hide missing or duplicate tests", () => {
  const one = parseInstrumentation(complete(result("one")));
  const two = parseInstrumentation(complete(result("two")));
  assert.equal(mergeInstrumentation([one, two], ["sample.Test#one", "sample.Test#two"]).passed, true);
  assert.equal(mergeInstrumentation([one], ["sample.Test#one", "sample.Test#two"]).passed, false);
  assert.equal(mergeInstrumentation([one, one], ["sample.Test#one"]).passed, false);
});
