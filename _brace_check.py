import pathlib
text = pathlib.Path('app.js').read_text(encoding='utf-8')
stack=[]
line=1
col=0
for ch in text:
    if ch=='\n':
        line+=1; col=0
        continue
    col+=1
    if ch=='{':
        stack.append((line,col))
    elif ch=='}':
        if stack:
            stack.pop()

print('unclosed count', len(stack))
print('unclosed openings', stack)
