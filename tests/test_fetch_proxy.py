"""Proxy URL resolution for the Market Pulse fetcher (discovery + transcripts)."""
import fetch_transcripts as F


def test_no_proxy_by_default(monkeypatch):
    for k in ("YT_PROXY", "WEBSHARE_USER", "WEBSHARE_PASS"):
        monkeypatch.delenv(k, raising=False)
    assert F._proxy_url() is None


def test_webshare_creds_derive_rotating_endpoint(monkeypatch):
    monkeypatch.delenv("YT_PROXY", raising=False)
    monkeypatch.setenv("WEBSHARE_USER", "myuser")
    monkeypatch.setenv("WEBSHARE_PASS", "mypass")
    assert F._proxy_url() == "http://myuser-rotate:mypass@p.webshare.io:80"


def test_explicit_yt_proxy_takes_precedence(monkeypatch):
    monkeypatch.setenv("YT_PROXY", "http://u:p@proxy.example:8080")
    monkeypatch.setenv("WEBSHARE_USER", "myuser")
    monkeypatch.setenv("WEBSHARE_PASS", "mypass")
    assert F._proxy_url() == "http://u:p@proxy.example:8080"


def test_partial_webshare_creds_are_ignored(monkeypatch):
    monkeypatch.delenv("YT_PROXY", raising=False)
    monkeypatch.setenv("WEBSHARE_USER", "myuser")
    monkeypatch.delenv("WEBSHARE_PASS", raising=False)
    assert F._proxy_url() is None
