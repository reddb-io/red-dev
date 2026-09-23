# Product

## Register

product

## Users

Developers maintaining one working environment across Ubuntu desktop, Ubuntu under WSL, and native Windows. They use red-dev while installing, repairing, and operating the machine, often entirely from the keyboard and sometimes while the machine is only partly configured.

## Product Purpose

red-dev converges a curated development environment across its supported targets from one portable binary. Success means that the same command, shortcut, terminal stack, and recovery path behave predictably everywhere, with enough visible evidence to understand what changed and what still needs attention.

## Brand Personality

Decisive, technical, and restrained. The product should feel opinionated without becoming mysterious, and polished without turning machine administration into decoration.

## Anti-references

- Generic installer chrome that stretches sparse content across the whole terminal.
- Dashboard-style card grids, ornamental borders, and visual noise that compete with the task.
- Platform mimicry that silently drops capabilities or changes semantics on another target.
- Interfaces that hide failures, destructive effects, or required privileges behind optimistic copy.

## Design Principles

- One intent, adapted honestly to each host.
- Keep the primary decision close and everything else progressively disclosed.
- Keyboard operation is the primary path, not an accessibility afterthought.
- Show concrete state and outcomes instead of implied success.
- Borrow proven interaction patterns while keeping red-dev's own information architecture.

## Accessibility & Inclusion

Every operation must remain reachable without a mouse. Focus and selection cannot depend on color alone, text must retain strong contrast, reduced terminal dimensions must remain usable, and non-interactive command equivalents must remain available for automation and assistive workflows.
