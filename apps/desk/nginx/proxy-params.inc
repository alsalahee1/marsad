# Shared by every proxied location in default.conf.template.
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $marsad_forwarded_proto;
proxy_set_header X-Forwarded-Host $host;
proxy_redirect off;
