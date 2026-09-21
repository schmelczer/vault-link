import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTrace, traceTest } from "./workload";

test("concrete traces replay all choices and retain preservation assertions with delayed events", () => {
    const trace = generateTrace(42, 12);
    assert.deepEqual(trace, generateTrace(42, 12));
    assert.notDeepEqual(trace, generateTrace(43, 12));
    assert.deepEqual(
        traceTest(trace),
        traceTest(JSON.parse(JSON.stringify(trace)))
    );
    assert.equal(
        trace.steps.filter((step) => step.type === "assert-markers").length,
        12
    );
    assert(trace.steps.some((step) => step.type === "delay-notifications"));
    assert(trace.steps.some((step) => step.type === "delete"));
    assert(trace.steps.some((step) => step.type === "assert-documents"));
    const assertions = trace.steps.filter(
        (step) => step.type === "assert-documents"
    );
    assert(
        assertions.at(-1)!.expected.some((doc) => doc.conflict),
        "Independent creates need two expected documents"
    );
    assert(
        assertions
            .at(-1)!
            .expected.some((doc) =>
                assertions[0].expected.some(
                    (initial) => initial.key === doc.key
                )
            ),
        "Later assertions must retain earlier identities"
    );
    for (const kind of ["create", "manifest", "content"]) {
        assert(
            Array.from({ length: 10 }, (_, seed) =>
                generateTrace(seed, 9)
            ).some((generated) =>
                generated.steps.some(
                    (step) =>
                        step.type === "drop-response" && step.kind === kind
                )
            )
        );
    }
    const delayed = trace.steps.findIndex(
        (step) => step.type === "delay-notifications"
    );
    const flushed = trace.steps.findIndex(
        (step, i) => i > delayed && step.type === "flush-notifications"
    );
    assert(
        trace.steps
            .slice(delayed, flushed)
            .some((step) => step.type === "enable-sync")
    );
    assert(
        trace.steps
            .slice(delayed, flushed)
            .some((step) => step.type === "assert-documents")
    );
    assert.equal(traceTest({ ...trace, clients: undefined }).clients, 2);
    assert(
        Array.from({ length: 10 }, (_, seed) => generateTrace(seed, 1)).some(
            (generated) => generated.clients === 3
        )
    );
});
