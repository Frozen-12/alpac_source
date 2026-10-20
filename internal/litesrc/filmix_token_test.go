package litesrc

import (
	"context"
	stdjson "encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFilmixPremiumTokenWinsOverOtherFXAccount(t *testing.T) {
	for _, tc := range []struct {
		name, post, query, quality string
	}{
		{"movie-hdr", `{"player_links":{"movie":[{"translation":"HEVC HDR 4K","link":"https://cdn.cdnsqu.com/s/paid/HEVC/film_[2160,1080,720,480].mp4"}]}}`, "", "2160p"},
		{"movie-single-quality", `{"player_links":{"movie":[{"translation":"Dub","link":"https://cdn.cdnsqu.com/s/paid/film_[2160].mp4"}]}}`, "", "2160p"},
		{"movie-unnamed", `{"player_links":{"movie":[{"link":"https://cdn.cdnsqu.com/s/paid/film_[1080].mp4"}]}}`, "", "1080p"},
		{"movie-explicit-qualities", `{"player_links":{"movie":[{"translation":"Dub","link":"https://cdn.cdnsqu.com/s/paid/film_%s.mp4","qualities":[480,4320,1080,4320]}]}}`, "", "4320p"},
		{"episode", `{"player_links":{"playlist":{"1":{"Dub":{"1":{"link":"https://cdn.cdnsqu.com/s/paid/s01e01_%s.mp4","qualities":[480,1080,2160,720]}}}}}}`, "&s=1", "2160p"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var fxCalls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/api-fx/") {
					fxCalls.Add(1)
					http.Error(w, "unrelated account", http.StatusForbidden)
					return
				}
				if r.URL.Query().Get("user_dev_token") != "paid-token" {
					t.Error("effective premium token was not used")
				}
				switch r.URL.Path {
				case "/api/v2/user_profile":
					fmt.Fprint(w, `{"user_data":{"is_pro":false,"is_pro_plus":true}}`)
				case "/api/v2/post/123":
					fmt.Fprint(w, tc.post)
				default:
					http.NotFound(w, r)
				}
			}))
			defer up.Close()
			f := &filmixChecker{client: up.Client(), hosts: []string{up.URL}, token: "paid-token", fxHost: up.URL, fxUser: "free-account", fxPasswd: "unused", hls: true, fxDirectLampa: true, fxPrimary: true}
			rec := httptest.NewRecorder()
			f.index(rec, httptest.NewRequest(http.MethodGet, "http://local/lite/filmix?postid=123&rjson=true"+tc.query, nil), nil)
			var payload struct {
				Data []struct {
					URL     string              `json:"url"`
					Streams []map[string]string `json:"streamquality"`
					Direct  any                 `json:"fxdirect"`
				} `json:"data"`
			}
			if err := stdjson.Unmarshal(rec.Body.Bytes(), &payload); err != nil || len(payload.Data) == 0 {
				t.Fatalf("missing playable rows: %s (%v)", rec.Body.String(), err)
			}
			row := payload.Data[0]
			if len(row.Streams) == 0 || row.Streams[0]["quality"] != tc.quality {
				t.Fatalf("highest quality must be selected: %#v", row.Streams)
			}
			if !strings.Contains(row.URL, "/s/paid/") || strings.Contains(row.URL, "%s") || strings.Contains(row.URL, "[") {
				t.Fatalf("token signature or resolved filename lost: %s", row.URL)
			}
			if row.Direct != nil || fxCalls.Load() != 0 {
				t.Fatal("api-fx or client-side mint must not replace the premium token")
			}
		})
	}
}

func TestFilmixTokenEntitlementsAreScopedCachedAndExpire(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.URL.Query().Get("user_dev_token") {
		case "paid":
			fmt.Fprint(w, `{"user_data":{"is_pro_plus":true}}`)
		case "free":
			fmt.Fprint(w, `{"user_data":{"is_pro":false,"is_pro_plus":false}}`)
		default:
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		}
	}))
	defer up.Close()
	f := &filmixChecker{client: up.Client(), hosts: []string{up.URL}, pro: true, token: "paid"}
	ctx := context.Background()
	if !f.tokenHasPremium(ctx, "paid") || !f.tokenHasPremium(ctx, "paid") || calls.Load() != 1 {
		t.Fatal("positive rights should be cached per token")
	}
	if f.tokenHasPremium(ctx, "free") || f.allowQuality(2160, "free") || f.tokenHasPremium(ctx, "unknown-kit-token") {
		t.Fatal("global pro flag or another token's rights must not grant premium")
	}
	if !f.allowQuality(2160, "paid") || !f.allowQuality(4320, "paid") || f.allowQuality(720, "") || f.allowQuality(0, "paid") {
		t.Fatal("quality limits do not follow the effective token")
	}
	f.tokenRights.Store("paid", filmixTokenRights{true, time.Now().Add(-time.Second)})
	if f.cachedTokenPremium("paid") {
		t.Fatal("expired rights must not be used")
	}
	if !f.tokenHasPremium(ctx, "paid") {
		t.Fatal("expired profile should be refreshed")
	}
}

func TestFilmixPremiumTokenFallsBackWhenPostUnavailable(t *testing.T) {
	for _, post := range []string{
		`{"player_links":{"movie":[{"translation":"Заблокировано правообладателем!","link":"https://cdn/s/paid/f_[2160].mp4"}]}}`,
		`{"player_links":{"movie":[]}}`,
	} {
		var fxCalls atomic.Int32
		up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v2/user_profile":
				fmt.Fprint(w, `{"user_data":{"is_pro_plus":true}}`)
			case "/api/v2/post/123":
				fmt.Fprint(w, post)
			case "/api-fx/request-token":
				fxCalls.Add(1)
				fmt.Fprint(w, `{"token":"fallback"}`)
			case "/api-fx/post/123/video-links":
				fmt.Fprint(w, `[{"voiceover":"Fallback","files":[{"quality":1080,"url":"https://cdn/hls/f_1080.mp4/index.m3u8?hash=fallback"}]}]`)
			default:
				http.NotFound(w, r)
			}
		}))
		f := &filmixChecker{client: up.Client(), hosts: []string{up.URL}, token: "paid", fxHost: up.URL}
		rec := httptest.NewRecorder()
		f.index(rec, httptest.NewRequest(http.MethodGet, "http://local/lite/filmix?postid=123&rjson=true", nil), nil)
		if fxCalls.Load() != 1 || !strings.Contains(rec.Body.String(), "Fallback") {
			t.Fatalf("unavailable token post must fall back: %s", rec.Body.String())
		}
		up.Close()
	}
}
