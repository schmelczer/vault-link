# Sync Algorithm

VaultLink uses operational transformation (OT) to handle concurrent edits and maintain consistency across clients. This document explains how the algorithm works.

## Operational Transformation

Operational transformation is a technique for managing concurrent edits to the same document. It transforms operations (edits) so they can be applied in different orders while preserving user intent.

### Why OT?

Traditional conflict resolution approaches:

- **Last write wins**: Loses data, frustrating for users
- **Manual merging**: Interrupts workflow, requires user intervention
- **Version branching**: Complex, not suitable for real-time sync

Operational transformation:

- **Automatic**: No user intervention required
- **Preserves all edits**: No data loss
- **Real-time**: Changes appear immediately
- **Intuitive**: Behavior matches user expectations

## The reconcile-text Library

VaultLink uses the [`reconcile-text`](https://crates.io/crates/reconcile-text) Rust library for operational transformation on text documents.

### Why reconcile-text over CRDTs?

VaultLink faces a **differential synchronization** challenge: users edit Obsidian vaults with various editors (Obsidian desktop, Obsidian mobile, Vim, VS Code, or any text editor), often while offline. This means we only observe the **final state** of each document after editing, not the individual keystrokes or operations that produced it.

**The fundamental problem**:

- **CRDTs and traditional OT** require capturing every individual operation (each character insertion, deletion, cursor movement)
- **VaultLink's reality**: Users edit files with arbitrary tools, sync happens after the fact
- **What we know**: Parent version and two modified versions
- **What we don't know**: The sequence of operations that created those modifications

**Why reconcile-text wins for this use case**:

1. **Works with end states only**: reconcile-text performs conflict-free 3-way merging given just parent, left, and right versions—no operation history needed

2. **Editor-agnostic**: Users can edit with any tool without requiring VaultLink-specific plugins or operation tracking

3. **Offline-first**: Edits made while disconnected are merged cleanly when sync resumes, because we're diffing final states rather than replaying operations

4. **No conflict markers**: Unlike Git merge, produces clean merged output without `<<<<<<<` markers that interrupt note-taking flow

5. **Human text forgiveness**: For knowledge bases and documentation, a slightly imperfect merge (e.g., minor word order issues) is vastly preferable to manual conflict resolution

6. **Simpler infrastructure**: No need for complex operation capture, transformation logs, or tombstone management that CRDTs require

**The tradeoff**:

CRDTs excel when you control the entire editing infrastructure and can capture every operation. reconcile-text excels when you're synchronizing independently-edited files—exactly VaultLink's scenario. The merge quality depends on Myers' diff algorithm rather than operation history, which is the correct tradeoff for differential sync.

For note-taking workflows where users value editor freedom and offline editing, this approach provides superior user experience compared to either CRDTs (which would require operation tracking) or Git-style merging (which requires manual conflict resolution).

[Learn more about reconcile-text →](https://schmelczer.dev/reconcile)

### How It Works

Given a base document and two sets of changes, OT produces a merged result that includes both changes.

**Example**:

```
Base document: "Hello world"

User A: "Hello beautiful world"  (inserts "beautiful ")
User B: "Hello world!"            (inserts "!")

OT result: "Hello beautiful world!"  (both changes applied)
```

### Operation Types

The algorithm handles these operations:

- **Insert**: Add text at position
- **Delete**: Remove text from position
- **Retain**: Keep existing text unchanged

### Transformation Process

1. **Client A** makes edit and sends to server
2. **Client B** makes concurrent edit and sends to server
3. **Server** receives both edits
4. **Server** transforms operations to account for concurrent changes
5. **Server** applies merged result to database
6. **Server** sends transformed operations to both clients
7. **Clients** apply transformed operations locally

## Sync State Management

VaultLink maintains sync state to track which changes have been applied.

### Version Vectors

Each document has a version tracked by:

- **Server version**: Incremented on each change
- **Client cursors**: Track which version each client has seen

This enables:

- Efficient syncing (only send changes since last sync)
- Conflict detection (concurrent edits to same version)
- Ordering of operations

### Cursor Management

Clients maintain a cursor position:

```rust
struct Cursor {
    vault_id: String,
    client_id: String,
    last_version: u64,
    last_updated: DateTime,
}
```

On sync:

1. Client sends cursor (last seen version)
2. Server returns all changes since that version
3. Client applies changes and updates cursor

## Conflict Resolution Flow

### Scenario: Concurrent Edits

Two users edit the same paragraph simultaneously.

**Initial state**:

```
Version 10: "The quick brown fox jumps over the lazy dog."
```

**User A's edit** (version 11):

```
"The quick brown fox jumps over the very lazy dog."
```

_Inserts "very " at position 40_

**User B's edit** (also from version 10):

```
"The quick red fox jumps over the lazy dog."
```

_Replaces "brown" with "red" at position 10_

### Server Processing

1. **Receive User A's operation**:
    - Base: version 10
    - Operation: Insert("very ", position=40)
    - Apply to database → version 11

2. **Receive User B's operation**:
    - Base: version 10
    - Operation: Replace("brown"→"red", position=10)
    - **Conflict detected**: Base is version 10, but current is version 11

3. **Transform User B's operation**:
    - Transform against User A's operation
    - Adjust positions/content as needed
    - Apply transformed operation → version 12

4. **Broadcast updates**:
    - Send User A's operation to User B
    - Send transformed User B's operation to User A

### Final Result

```
Version 12: "The quick red fox jumps over the very lazy dog."
```

Both edits are preserved in the final document.

## Edge Cases

### 1. Delete vs Insert Conflict

**Scenario**: User A deletes a paragraph while User B edits it.

**Resolution**:

- OT algorithm prioritizes preservation of content
- Insert operation is transformed to account for deletion
- Typically results in inserted content appearing nearby

**Example**:

```
Base: "Line 1\nLine 2\nLine 3"

User A: Delete Line 2 → "Line 1\nLine 3"
User B: Edit Line 2 → "Line 1\nLine 2 modified\nLine 3"

Result: "Line 1\nLine 2 modified\nLine 3"
```

(Insert takes precedence, preserving user content)

### 2. Overlapping Edits

**Scenario**: Two users edit overlapping regions.

**Resolution**:

- OT splits operations into non-overlapping segments
- Applies each segment independently
- Merges results

### 3. Delete vs Delete

**Scenario**: Two users delete overlapping text.

**Resolution**:

- Deletes are merged
- Final result has the union of deleted ranges removed

### 4. Network Partitions

**Scenario**: Client loses connection, makes edits offline, reconnects.

**Resolution**:

1. Client queues edits locally
2. On reconnect, sends all queued operations
3. Server applies OT against all operations that happened during partition
4. Client receives transformed operations and applies

## Performance Characteristics

### Time Complexity

- **Single operation**: O(1) for most operations
- **Transformation**: O(n) where n is operation size
- **Conflict resolution**: O(m × n) where m is number of concurrent operations

### Space Complexity

- **Version history**: Grows with number of changes
- **Cursors**: O(clients × vaults)
- **Active operations**: Minimal (processed in real-time)

### Optimization

VaultLink optimizes for:

- Small, frequent edits (typical typing patterns)
- Text documents (not binary files)
- Real-time processing (no batching delay)

## Limitations

### Binary Files

OT works best for text files. Binary files:

- Cannot be meaningfully merged
- Use last-write-wins strategy
- May cause data loss on concurrent edits

**Workaround**: Avoid concurrent edits to binary files, or use versioning.

### Large Documents

Very large documents (> 1MB) may have:

- Higher transformation costs
- Slower sync times
- Increased memory usage

**Workaround**: Split large documents or increase timeout settings.

### Complex Formatting

Markdown with complex structures may occasionally produce unexpected results:

- Nested lists
- Tables
- Code blocks

**Workaround**: Manual cleanup if needed, or minimize concurrent edits to complex structures.

## Consistency Guarantees

### Strong Consistency

VaultLink provides **strong eventual consistency**:

- All clients eventually converge to the same state
- Operations applied in causal order
- No data loss under normal operation

### Ordering Guarantees

- Operations from the same client are applied in order
- Concurrent operations may be applied in any order
- Final result is independent of operation order (commutative)

### Durability

- Operations are written to SQLite before acknowledgment
- SQLite ACID guarantees protect against data loss
- Clients retry failed uploads

## Comparison with Other Approaches

### Git-style Merging

| Aspect                     | Git Merge    | VaultLink OT            |
| -------------------------- | ------------ | ----------------------- |
| Real-time                  | No           | Yes                     |
| Manual conflict resolution | Yes          | No                      |
| Branching                  | Yes          | No                      |
| Automatic merge            | Limited      | Always                  |
| Use case                   | Code changes | Collaborative documents |

### CRDTs (Conflict-free Replicated Data Types)

| Aspect                        | CRDTs                                | VaultLink (reconcile-text)                        |
| ----------------------------- | ------------------------------------ | ------------------------------------------------- |
| **Operation tracking**        | Required (every keystroke)           | Not required (end states only)                    |
| **Editor freedom**            | Limited (must use CRDT-aware editor) | Unlimited (any text editor works)                 |
| **Offline editing**           | Requires operation log               | Works with file comparison                        |
| **Server required**           | No                                   | Yes                                               |
| **Memory overhead**           | Higher (tombstones, metadata)        | Lower (versions only)                             |
| **Infrastructure complexity** | Higher                               | Lower                                             |
| **Best for**                  | Controlled editing environments      | Independent file editing (Obsidian, Vim, VS Code) |

**Key insight**: CRDTs are superior when you can capture every operation. reconcile-text is superior when users edit files independently with arbitrary tools—exactly VaultLink's scenario.

### Last Write Wins

| Aspect          | LWW  | VaultLink OT |
| --------------- | ---- | ------------ |
| Data loss       | Yes  | No           |
| Simplicity      | High | Medium       |
| User experience | Poor | Excellent    |
| Performance     | Best | Good         |

## Algorithm Details

### Transformation Rules

When transforming operation `A` against operation `B`:

1. **Insert vs Insert**:
    - If positions equal: Order by client ID
    - If different positions: Adjust positions

2. **Insert vs Delete**:
    - If insert in deleted range: Shift insert position
    - If insert after delete: Adjust position by deleted length

3. **Delete vs Delete**:
    - If ranges overlap: Merge delete ranges
    - If ranges disjoint: Adjust positions

4. **Retain vs Any**:
    - Retain operations don't conflict
    - Simply adjust positions

### Transformation Example

```rust
// Pseudo-code for transformation
fn transform(op_a: Operation, op_b: Operation) -> (Operation, Operation) {
    match (op_a, op_b) {
        (Insert(pos_a, text_a), Insert(pos_b, text_b)) => {
            if pos_a < pos_b {
                (op_a, Insert(pos_b + text_a.len(), text_b))
            } else if pos_a > pos_b {
                (Insert(pos_a + text_b.len(), text_a), op_b)
            } else {
                // Same position, use client ID to break tie
                if client_id_a < client_id_b {
                    (op_a, Insert(pos_b + text_a.len(), text_b))
                } else {
                    (Insert(pos_a + text_b.len(), text_a), op_b)
                }
            }
        }
        // ... other cases
    }
}
```

## Best Practices

### For Smooth Collaboration

1. **Small edits**: Make small, focused changes for easier merging
2. **Coordinate major changes**: Discuss large refactors with team
3. **Monitor sync status**: Ensure changes are uploaded before signing off
4. **Test conflict resolution**: Verify behavior matches expectations

### For Developers

1. **Text files preferred**: OT works best on text
2. **Limit file sizes**: Keep documents reasonably sized
3. **Binary files**: Use versioning or avoid concurrent edits
4. **Testing**: Test concurrent edit scenarios thoroughly

## Further Reading

- [reconcile-text library](https://crates.io/crates/reconcile-text)
- [Operational Transformation FAQ](https://en.wikipedia.org/wiki/Operational_transformation)
- [Data flow architecture →](/architecture/data-flow)
