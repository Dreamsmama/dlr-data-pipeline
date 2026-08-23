UPDATE feishu_attachments
SET name = convert_from(convert_to(name, 'LATIN1'), 'UTF8'),
    updated_at = now()
WHERE name ~ U&'[\0080-\009F]';
