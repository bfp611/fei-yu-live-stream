import unittest
from unittest.mock import patch
from game_video import GameVideo


class Video(unittest.TestCase):
    def test_stats_are_bounded_numeric_and_do_not_extend_lease(self):
        video=GameVideo()
        with patch('game_video.time.monotonic',return_value=10):
            video.write({'kind':'offer','id':'a','sdp':'v=0'})
        video.write({'kind':'stats','id':'a','values':{'fps':60,'frames':120}})
        for values in ({'fps':float('nan')}, {'fps':-1}, {'command':'sell'}, {'fps':'60'}):
            with self.assertRaises(ValueError): video.write({'kind':'stats','id':'a','values':values})
        with patch('game_video.time.monotonic',return_value=26):
            self.assertIsNone(video.read())

    def test_receiver_counters_are_separate_from_sender(self):
        video=GameVideo();video.write({'kind':'offer','id':'a','sdp':'v=0'})
        video.write({'kind':'stats','id':'a','values':{'fps':60}})
        video.write({'kind':'heartbeat','id':'a','values':{'fps':59,'dropped':1}})
        self.assertEqual(video.read()['sourceStats']['fps'],60)
        self.assertEqual(video.read()['viewerStats']['dropped'],1)

    def test_single_viewer_and_stale_answers(self):
        video=GameVideo()
        video.write({'kind':'offer','id':'a','sdp':'v=0\noffer'})
        with self.assertRaises(ValueError): video.write({'kind':'offer','id':'b','sdp':'v=0\nb'})
        with self.assertRaises(ValueError): video.write({'kind':'answer','id':'b','sdp':'v=0\nanswer'})
        video.write({'kind':'answer','id':'a','sdp':'v=0\nanswer'})
        self.assertEqual(video.read()['answer'],'v=0\nanswer')
        video.write({'kind':'close','id':'a'})
        self.assertIsNone(video.read())

    def test_expired_viewer_releases_source(self):
        video=GameVideo()
        with patch('game_video.time.monotonic',return_value=10):
            video.write({'kind':'offer','id':'a','sdp':'v=0'})
        with patch('game_video.time.monotonic',return_value=26):
            self.assertIsNone(video.read())

    def test_signaling_cannot_carry_game_actions(self):
        video=GameVideo()
        for body in ({'kind':'command','id':'a'}, {'kind':'offer','id':'a','sdp':'x'*64001}, {'kind':'offer','id':{},'sdp':'v=0'}):
            with self.assertRaises(ValueError): video.write(body)
