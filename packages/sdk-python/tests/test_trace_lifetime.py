"""A task spawned during a request must not keep that request's trace once it ends."""

import asyncio

from apilens.client.trace import begin_request_trace, current_span_id, current_trace_id, current_traceparent, end_request_trace


def test_spawned_task_sees_the_trace_only_while_the_request_runs():
    async def scenario():
        seen: list[str] = []
        request_done = asyncio.Event()
        checked = asyncio.Event()

        async def background():
            # A long-lived task (a lazily started server, a worker loop) copies the context.
            seen.append(current_trace_id())
            await request_done.wait()
            seen.append(current_trace_id())
            seen.append(current_span_id())
            seen.append(current_traceparent())
            checked.set()

        trace_id, _, _, token = begin_request_trace(None)
        task = asyncio.create_task(background())
        await asyncio.sleep(0)
        end_request_trace(token)
        request_done.set()
        await checked.wait()
        await task
        return trace_id, seen

    trace_id, seen = asyncio.run(scenario())
    assert seen == [trace_id, "", "", ""]


def test_the_trace_is_cleared_in_the_request_context_after_it_ends():
    trace_id, span_id, _, token = begin_request_trace(None)
    assert current_trace_id() == trace_id
    assert current_traceparent() == f"00-{trace_id}-{span_id}-01"
    end_request_trace(token)
    assert current_trace_id() == ""
