export const ILLEGAL_CHARS = /[<>\[\]?*|:]/g;
export const DEFAULT_TIME_LIMIT = 2000;
export const DEFAULT_MEMORY_LIMIT = 1024;

export const TEMPLATE = `"""
    Name    | Ruoqi Huang
    Contest | {contest}
    Problem | {problem}
    Time    | {time}
"""
import sys; input = lambda: sys.stdin.readline().rstrip("\\r\\n")
ii = lambda: int(input())
si = lambda: input().split()
mi = lambda: list(map(int, input().split()))


for _ in range(ii()):

`;

